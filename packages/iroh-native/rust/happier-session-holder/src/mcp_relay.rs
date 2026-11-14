//! `mcp-relay [--tool-name-max-length <n>]`: the Session MCP stdio server an Agent
//! launches. It pipes the Agent's MCP stdio (newline-delimited JSON-RPC) to its
//! Session's MCP endpoint in the session host and back; the host serves every tool.
//!
//! The endpoint comes from the Session MCP context file named by
//! `HAPPIER_SESSION_MCP_CONTEXT_FILE` (an Agent held in a target has none: the
//! context is its own holder's, found among its ancestors, `session_mcp.rs`): a Unix socket (`socketPath`; the host admits
//! this process by kernel peer identity in the Session's Agent tree, so the
//! Agent-visible context carries no bearer) or, on Windows, `url`
//! `http://127.0.0.1:<port>`, whose bearer arrives only in this relay's MCP client
//! config env (`HAPPIER_SESSION_MCP_BEARER`), never in the context file the Agent's
//! shell can read. A context still carrying `bearerToken` is accepted. The relay
//! upgrades one HTTP/1.1 connection (`Upgrade: happier-mcp-relay`, the bearer when
//! present, the Agent's tool-name budget); after
//! `101` the connection carries the MCP stdio bytes both ways. Nothing is ever printed
//! to stdout except the endpoint's MCP bytes.

use std::io::{self, Read, Write};
use std::thread;

use serde_json::Value;

pub const CONTEXT_FILE_ENV: &str = "HAPPIER_SESSION_MCP_CONTEXT_FILE";
pub const BEARER_ENV: &str = "HAPPIER_SESSION_MCP_BEARER";

#[derive(Debug, PartialEq)]
pub enum Endpoint {
    Socket(String),
    Loopback(String),
}

fn valid_bearer(bearer: &str) -> bool {
    bearer.len() == 43 && bearer.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The context file's closed shape (`sessionMcpLocalContext.ts`). A present bearer must be well formed.
pub fn parse_context(raw: &str) -> Option<(Endpoint, Option<String>)> {
    let value: Value = serde_json::from_str(raw).ok()?;
    if value.get("v").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    let bearer = match value.get("bearerToken") {
        None => None,
        Some(token) => {
            let token = token.as_str()?;
            if !valid_bearer(token) {
                return None;
            }
            Some(token.to_owned())
        }
    };
    let endpoint = if let Some(path) = value.get("socketPath").and_then(Value::as_str) {
        Endpoint::Socket(path.to_owned())
    } else {
        let url = value.get("url")?.as_str()?;
        let rest = url.strip_prefix("http://127.0.0.1:")?.trim_end_matches('/');
        let port: u16 = rest.parse().ok()?;
        Endpoint::Loopback(format!("127.0.0.1:{port}"))
    };
    Some((endpoint, bearer))
}

/// The loopback endpoint admits only its bearer; a Unix socket admits the Agent tree by peer identity.
pub fn resolve_bearer(endpoint: &Endpoint, context_bearer: Option<String>, env_bearer: Option<String>) -> Option<Option<String>> {
    let bearer = match (context_bearer, env_bearer) {
        (Some(bearer), _) => Some(bearer),
        (None, Some(bearer)) if valid_bearer(&bearer) => Some(bearer),
        (None, Some(_)) => return None,
        (None, None) => None,
    };
    match endpoint {
        Endpoint::Loopback(_) if bearer.is_none() => None,
        _ => Some(bearer),
    }
}

pub const UPGRADE: &str = "happier-mcp-relay";
/// Protocol boundary: the endpoint's `101` response head is a few short lines.
const RESPONSE_HEAD_MAX_BYTES: usize = 4096;

pub fn upgrade_request(bearer: Option<&str>, tool_name_max_length: Option<u32>) -> Vec<u8> {
    let budget = tool_name_max_length.map(|max| format!("X-Happier-Tool-Name-Max-Length: {max}\r\n")).unwrap_or_default();
    let authorization = bearer.map(|bearer| format!("Authorization: Bearer {bearer}\r\n")).unwrap_or_default();
    format!(
        "GET /mcp-relay HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: {UPGRADE}\r\n{authorization}{budget}\r\n"
    )
    .into_bytes()
}

/// Reads the response head; returns the bytes after it when the endpoint switched protocols.
pub fn read_upgrade_response<R: Read>(reader: &mut R) -> Option<Vec<u8>> {
    let mut head = Vec::new();
    let mut buffer = [0u8; 1024];
    loop {
        let n = reader.read(&mut buffer).ok()?;
        if n == 0 {
            return None;
        }
        head.extend_from_slice(&buffer[..n]);
        if let Some(end) = head.windows(4).position(|window| window == b"\r\n\r\n") {
            let status = head.split(|b| *b == b'\r').next()?;
            if !status.starts_with(b"HTTP/1.1 101 ") {
                return None;
            }
            return Some(head[end + 4..].to_vec());
        }
        if head.len() > RESPONSE_HEAD_MAX_BYTES {
            return None;
        }
    }
}

pub fn parse_args(args: &[String]) -> Option<Option<u32>> {
    match args {
        [] => Some(None),
        [flag, value] if flag == "--tool-name-max-length" => value.parse().ok().map(Some),
        _ => None,
    }
}

fn fail() -> ! {
    // Content-free, like the Node bridge it replaces: no path, bearer or body.
    eprintln!("[happier-mcp] Fatal: mcp_socket_access_unavailable");
    std::process::exit(1);
}

pub fn run(args: &[String]) -> ! {
    let tool_name_max_length = parse_args(args).unwrap_or_else(|| fail());
    // A Machine's Agent names its Session's context; an Agent held in a target reaches it through its own holder.
    let context = std::env::var_os(CONTEXT_FILE_ENV)
        .or_else(|| crate::session_mcp::holder_context_from_ancestry().map(Into::into))
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|raw| parse_context(&raw))
        .unwrap_or_else(|| fail());
    let (endpoint, context_bearer) = context;
    let env_bearer = std::env::var(BEARER_ENV).ok();
    let bearer = resolve_bearer(&endpoint, context_bearer, env_bearer).unwrap_or_else(|| fail());
    let request = upgrade_request(bearer.as_deref(), tool_name_max_length);
    match endpoint {
        Endpoint::Socket(path) => {
            #[cfg(unix)]
            {
                let stream = std::os::unix::net::UnixStream::connect(path).unwrap_or_else(|_| fail());
                let writer = stream.try_clone().unwrap_or_else(|_| fail());
                pipe(stream, writer, &request, |s| {
                    let _ = s.shutdown(std::net::Shutdown::Write);
                })
            }
            #[cfg(not(unix))]
            {
                let _ = path;
                fail()
            }
        }
        Endpoint::Loopback(address) => {
            let stream = std::net::TcpStream::connect(address).unwrap_or_else(|_| fail());
            let _ = stream.set_nodelay(true);
            let writer = stream.try_clone().unwrap_or_else(|_| fail());
            pipe(stream, writer, &request, |s| {
                let _ = s.shutdown(std::net::Shutdown::Write);
            })
        }
    }
}

/// Upgrade, then stdin → endpoint on a thread and endpoint → stdout here. The process
/// exits when the endpoint closes (the Session's MCP ended), which the Agent sees as
/// its MCP server exiting.
fn pipe<R: Read, W: Write + Send + 'static>(mut from_host: R, mut to_host: W, request: &[u8], shutdown: fn(&mut W)) -> ! {
    if to_host.write_all(request).and_then(|_| to_host.flush()).is_err() {
        fail();
    }
    let early = read_upgrade_response(&mut from_host).unwrap_or_else(|| fail());
    thread::spawn(move || {
        let _ = io::copy(&mut io::stdin().lock(), &mut to_host);
        shutdown(&mut to_host);
    });
    let mut stdout = io::stdout().lock();
    if !early.is_empty() && stdout.write_all(&early).and_then(|_| stdout.flush()).is_err() {
        std::process::exit(0);
    }
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        match from_host.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                // Rust's stdout is line-buffered: flush every chunk.
                if stdout.write_all(&buffer[..n]).and_then(|_| stdout.flush()).is_err() {
                    break;
                }
            }
        }
    }
    std::process::exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    const BEARER: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO_-";

    #[test]
    fn parses_both_context_shapes_and_refuses_others() {
        let socket = format!(r#"{{"v":1,"socketPath":"/run/x/mcp.sock","bearerToken":"{BEARER}"}}"#);
        assert_eq!(parse_context(&socket), Some((Endpoint::Socket("/run/x/mcp.sock".into()), Some(BEARER.into()))));
        let loopback = format!(r#"{{"v":1,"url":"http://127.0.0.1:4567/","bearerToken":"{BEARER}"}}"#);
        assert_eq!(parse_context(&loopback), Some((Endpoint::Loopback("127.0.0.1:4567".into()), Some(BEARER.into()))));
        // The Agent-visible context carries no bearer.
        assert_eq!(parse_context(r#"{"v":1,"socketPath":"/run/x/mcp.sock"}"#), Some((Endpoint::Socket("/run/x/mcp.sock".into()), None)));
        assert_eq!(parse_context(r#"{"v":1,"url":"http://127.0.0.1:4567"}"#), Some((Endpoint::Loopback("127.0.0.1:4567".into()), None)));
        // Off-host URLs and malformed bearers never leave the process.
        assert_eq!(parse_context(&format!(r#"{{"v":1,"url":"http://10.0.0.1:1/","bearerToken":"{BEARER}"}}"#)), None);
        assert_eq!(parse_context(r#"{"v":1,"socketPath":"/x","bearerToken":"short"}"#), None);
        assert_eq!(parse_context(&format!(r#"{{"v":2,"socketPath":"/x","bearerToken":"{BEARER}"}}"#)), None);
    }

    #[test]
    fn socket_relays_without_a_bearer_and_loopback_requires_its_config_bearer() {
        let socket = Endpoint::Socket("/run/x/mcp.sock".into());
        let loopback = Endpoint::Loopback("127.0.0.1:4567".into());
        assert_eq!(resolve_bearer(&socket, None, None), Some(None));
        assert_eq!(resolve_bearer(&loopback, None, None), None);
        assert_eq!(resolve_bearer(&loopback, None, Some(BEARER.into())), Some(Some(BEARER.into())));
        assert_eq!(resolve_bearer(&loopback, None, Some("short".into())), None);
        let request = String::from_utf8(upgrade_request(None, None)).unwrap();
        assert!(!request.contains("Authorization"));
        assert!(request.ends_with("Upgrade: happier-mcp-relay\r\n\r\n"));
    }

    #[test]
    fn upgrade_carries_bearer_and_budget_and_only_101_switches() {
        let request = String::from_utf8(upgrade_request(Some(BEARER), Some(64))).unwrap();
        assert!(request.starts_with("GET /mcp-relay HTTP/1.1\r\n"));
        assert!(request.contains(&format!("Authorization: Bearer {BEARER}\r\n")));
        assert!(request.contains("Upgrade: happier-mcp-relay\r\n"));
        assert!(request.contains("X-Happier-Tool-Name-Max-Length: 64\r\n"));
        assert!(request.ends_with("\r\n\r\n"));
        let switched = b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: happier-mcp-relay\r\n\r\n{\"jsonrpc\"";
        assert_eq!(read_upgrade_response(&mut &switched[..]), Some(b"{\"jsonrpc\"".to_vec()));
        let refused = b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n";
        assert_eq!(read_upgrade_response(&mut &refused[..]), None);
        assert_eq!(read_upgrade_response(&mut &b""[..]), None);
        assert_eq!(parse_args(&["--tool-name-max-length".into(), "64".into()]), Some(Some(64)));
        assert_eq!(parse_args(&["--url".into()]), None);
    }
}
