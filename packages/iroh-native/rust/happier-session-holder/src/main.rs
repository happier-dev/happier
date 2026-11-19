//! happier-session-holder: one Session's Agent custody process.
//!
//! `serve --socket <path> -- <argv...>` starts the Agent with piped stdio in its own
//! process group (with `--pty <cols>x<rows>`: as the session leader of a pseudo-terminal,
//! for terminal-mode Agents), prints one readiness JSON line on stdout, closes stdout and then
//! serves one client at a time on a same-user local socket (Unix socket created 0600,
//! or a Windows named pipe with an owner-only DACL that rejects remote clients). No
//! network port is ever opened. A new client replaces the old one and receives the
//! unacknowledged output again (see `outbox.rs`).
//!
//! `attach --socket <path>` bridges this process's stdio to a holder socket, so a
//! client can reach a holder through any exec channel (container/sandbox exec, ssh).
//!
//! `mcp-relay` is the Session MCP stdio server Agents launch: it pipes stdio to the
//! Session's MCP endpoint in the session host (see `mcp_relay.rs`). In a target, where
//! that endpoint is on another Machine, `serve --session-mcp` lets the holder carry its
//! Agent tree's relays on its own client channel (see `session_mcp.rs`).

#[cfg(windows)]
mod conpty;
mod frame;
mod loopback;
mod mcp_relay;
mod outbox;
mod platform;
mod session_mcp;
#[cfg(any(target_os = "linux", target_os = "macos", all(test, unix)))]
mod process_custody;
mod streams;
mod terminal;

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use outbox::Outbox;
use serde_json::{json, Value};

fn usage() -> ! {
    eprintln!("usage: happier-session-holder serve --socket <path> [--session-mcp] [--windows-verbatim] [--pty <cols>x<rows>] -- <argv...>\n       happier-session-holder attach --socket <path>\n       happier-session-holder workspace --root <path>\n       happier-session-holder mcp-relay [--tool-name-max-length <n>]");
    std::process::exit(2);
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("serve") => {
            let serve_args = parse_serve(&args[1..]).unwrap_or_else(|| usage());
            serve(&serve_args);
        }
        Some("attach") => match args.get(1..) {
            Some([flag, socket]) if flag == "--socket" => attach(socket),
            _ => usage(),
        },
        Some("workspace") => match args.get(1..) {
            Some([flag, root]) if flag == "--root" => {
                if std::env::set_current_dir(root).is_err() { std::process::exit(1); }
                serve_workspace_stdio(Box::new(std::io::stdin()), Box::new(WorkspaceStdout));
            }
            _ => usage(),
        },
        Some("mcp-relay") => mcp_relay::run(&args[1..]),
        Some("--version") => println!("{}", json!({ "protocol": frame::PROTOCOL_VERSION })),
        _ => usage(),
    }
}

struct ServeArgs {
    socket: String,
    /// The arguments are an already rendered Windows command line tail (Node's
    /// `windowsVerbatimArguments`) and are appended unquoted.
    verbatim: bool,
    /// Carry the Agent tree's Session MCP relays on the client channel (`session_mcp.rs`).
    session_mcp: bool,
    /// Hold the Agent in a pseudo-terminal of this size (cols, rows) instead of pipes.
    pty: Option<(u16, u16)>,
    argv: Vec<String>,
}

fn parse_serve(args: &[String]) -> Option<ServeArgs> {
    let separator = args.iter().position(|arg| arg == "--")?;
    let argv = args[separator + 1..].to_vec();
    if argv.is_empty() {
        return None;
    }
    let [flag, socket, options @ ..] = &args[..separator] else { return None };
    if flag != "--socket" {
        return None;
    }
    let (mut verbatim, mut session_mcp, mut pty) = (false, false, None);
    let mut options = options.iter();
    while let Some(option) = options.next() {
        match option.as_str() {
            "--windows-verbatim" if !verbatim => verbatim = true,
            "--session-mcp" if !session_mcp => session_mcp = true,
            "--pty" if pty.is_none() => pty = Some(parse_size(options.next()?)?),
            _ => return None,
        }
    }
    Some(ServeArgs { socket: socket.clone(), verbatim, session_mcp, pty, argv })
}

/// `<cols>x<rows>`, both positive.
fn parse_size(value: &str) -> Option<(u16, u16)> {
    let (cols, rows) = value.split_once('x')?;
    let (cols, rows) = (cols.parse::<u16>().ok()?, rows.parse::<u16>().ok()?);
    (cols > 0 && rows > 0).then_some((cols, rows))
}

fn ready_line(value: Value) {
    let mut stdout = std::io::stdout();
    let _ = writeln!(stdout, "{value}");
    let _ = stdout.flush();
}

fn serve(args: &ServeArgs) {
    let (socket, verbatim, argv) = (args.socket.as_str(), args.verbatim, &args.argv);
    platform::become_session_leader();
    let listener = match platform::Listener::bind(socket) {
        Ok(listener) => listener,
        Err(error) => {
            ready_line(json!({ "ready": false, "code": "holder_socket_unavailable", "message": error.to_string() }));
            std::process::exit(1);
        }
    };
    // Bound before the Agent starts, so its relay finds the context at once.
    let session_mcp = if args.session_mcp { session_mcp::bind(socket) } else { None };
    let mut command = Command::new(&argv[0]);
    platform::add_agent_args(&mut command, &argv[1..], verbatim);
    let spawned = match args.pty {
        Some((cols, rows)) => spawn_terminal_agent(&mut command, argv, verbatim, cols, rows),
        None => {
            command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
            platform::configure_agent_command(&mut command);
            command.spawn().map(|mut child| {
                let stdin = child.stdin.take().map(|pipe| Box::new(pipe) as Box<dyn Write + Send>);
                let outputs: Vec<(Box<dyn Read + Send>, u8)> = vec![
                    (Box::new(child.stdout.take().expect("piped stdout")), b'o'),
                    (Box::new(child.stderr.take().expect("piped stderr")), b'e'),
                ];
                HeldAgent::of_child(child, stdin, outputs)
            }).map_err(|error| json!({
                "ready": false,
                "code": "agent_spawn_failed",
                "errno": error.raw_os_error(),
                "kind": format!("{:?}", error.kind()),
                "message": error.to_string(),
            }))
        }
    };
    let HeldAgent { pid: agent_pid, wait, after_exit, stdin: agent_stdin, outputs } = match spawned {
        Ok(spawned) => spawned,
        Err(refusal) => {
            listener.remove();
            remove_session_mcp_paths(socket);
            ready_line(refusal);
            std::process::exit(1);
        }
    };
    let holder_pid = std::process::id();
    ready_line(json!({ "ready": true, "protocol": frame::PROTOCOL_VERSION, "holderPid": holder_pid, "agentPid": agent_pid }));
    // The spawner may exit or crash; the holder must never write to its pipes again.
    platform::detach_standard_streams();

    let outbox = Arc::new(Outbox::new());
    let stdin = Arc::new(Mutex::new(agent_stdin));
    let pumps: Vec<_> = outputs.into_iter().map(|(reader, kind)| pump(reader, kind, outbox.clone())).collect();
    let exit: Arc<Mutex<Option<Value>>> = Arc::new(Mutex::new(None));
    // Opaque client state kept for the next attachment (`meta` op); see frame.rs.
    let meta: Arc<Mutex<Value>> = Arc::new(Mutex::new(Value::Null));
    let streams: Arc<streams::Streams> = Arc::default();
    {
        let outbox = outbox.clone();
        let exit = exit.clone();
        let streams = streams.clone();
        thread::spawn(move || {
            // Root exit is reported as soon as it happens, like Node's `exit`; `z`
            // (streams closed) follows once every writer of the Agent's pipes is gone.
            let status = wait();
            *exit.lock().unwrap() = Some(status.clone());
            outbox.send(b'x', status.to_string().as_bytes());
            if let Some(after_exit) = after_exit {
                after_exit();
            }
            for pump in pumps {
                let _ = pump.join();
            }
            outbox.send_if_attached(b'z', b"{}");
            outbox.wait_exit_acknowledged();
            streams.terminate_all();
            listener_cleanup_and_exit();
        });
    }
    let socket_path = socket.to_string();
    SOCKET_PATH.lock().unwrap().replace(socket_path);
    if let Some(mcp_listener) = session_mcp {
        session_mcp::serve(mcp_listener, agent_pid, outbox.clone(), streams.clone());
    }
    // Workspace-operations clients (file ops, Git, search, watches, terminals) attach
    // at `<socket>.ops`, any number at once, without the Agent's stdio or process
    // ops; the one Agent-control client keeps the main socket. Same 0600 socket rules.
    let ops_path = workspace_ops_socket_path(socket);
    match platform::Listener::bind(&ops_path) {
        Ok(ops_listener) => {
            OPS_SOCKET_PATH.lock().unwrap().replace(ops_path);
            thread::spawn(move || loop {
                let Ok((reader, writer)) = ops_listener.accept() else { continue };
                let ops_outbox = Arc::new(Outbox::new());
                let hello = |replay_from: u64| {
                    json!({ "protocol": frame::PROTOCOL_VERSION, "holderPid": holder_pid, "role": "workspace", "replayFrom": replay_from })
                        .to_string().into_bytes()
                };
                let Some(generation) = ops_outbox.attach(writer, hello) else { continue };
                thread::spawn(move || serve_workspace_client(reader, generation, ops_outbox));
            });
        }
        // Without the ops socket the holder still serves its Agent; workspace clients see a refused connection.
        Err(_) => {}
    }
    loop {
        let (reader, writer) = match listener.accept() {
            Ok(connection) => connection,
            Err(_) => continue,
        };
        let stored_meta = meta.lock().unwrap().clone();
        let hello = |replay_from: u64| {
            json!({ "protocol": frame::PROTOCOL_VERSION, "holderPid": holder_pid, "agentPid": agent_pid, "replayFrom": replay_from,
                "meta": stored_meta })
                .to_string()
                .into_bytes()
        };
        let Some(generation) = outbox.attach(writer, hello) else { continue };
        let outbox = outbox.clone();
        let stdin = stdin.clone();
        let exit = exit.clone();
        let meta = meta.clone();
        let streams = streams.clone();
        thread::spawn(move || serve_client(reader, generation, outbox, stdin, agent_pid, exit, meta, streams));
    }
}

static SOCKET_PATH: Mutex<Option<String>> = Mutex::new(None);
/// The held Agent's terminal (`--pty`), for the primary client's `resize`: the master
/// descriptor on Unix, the pseudoconsole handle on Windows.
static AGENT_TERMINAL: Mutex<Option<isize>> = Mutex::new(None);

/// The started Agent: its pid, how to wait for its exit status, what to do once it exited
/// (Windows: close the pseudoconsole so its output ends), its input and its outputs.
struct HeldAgent {
    pid: u32,
    wait: Box<dyn FnOnce() -> Value + Send>,
    after_exit: Option<Box<dyn FnOnce() + Send>>,
    stdin: Option<Box<dyn Write + Send>>,
    outputs: Vec<(Box<dyn Read + Send>, u8)>,
}

impl HeldAgent {
    fn of_child(mut child: std::process::Child, stdin: Option<Box<dyn Write + Send>>, outputs: Vec<(Box<dyn Read + Send>, u8)>) -> Self {
        Self { pid: child.id(), wait: Box::new(move || platform::exit_json(child.wait())), after_exit: None, stdin, outputs }
    }
}

fn terminal_refusal(code: &str) -> Value {
    json!({ "ready": false, "code": "agent_spawn_failed", "kind": code, "message": format!("terminal Agent start failed: {code}") })
}

/// The Agent as the session leader of a new terminal: its output is one stream (`o`),
/// input goes to the terminal (`i`), and the primary client resizes it (`resize`).
#[cfg(unix)]
fn spawn_terminal_agent(command: &mut Command, _: &[String], _: bool, cols: u16, rows: u16) -> Result<HeldAgent, Value> {
    use std::fs::File;
    use std::os::fd::FromRawFd;
    let (child, master) = terminal::spawn_in_pty(command, cols, rows).map_err(terminal_refusal)?;
    let reader = unsafe { File::from_raw_fd(libc::dup(master)) };
    let writer = unsafe { File::from_raw_fd(master) };
    *AGENT_TERMINAL.lock().unwrap() = Some(master as isize);
    Ok(HeldAgent::of_child(child, Some(Box::new(writer)), vec![(Box::new(reader), b'o')]))
}

/// Windows: the Agent in the OS pseudoconsole (ConPTY), see `conpty.rs`.
#[cfg(windows)]
fn spawn_terminal_agent(_: &mut Command, argv: &[String], verbatim: bool, cols: u16, rows: u16) -> Result<HeldAgent, Value> {
    let agent = conpty::spawn(argv, verbatim, cols, rows).map_err(|error| terminal_refusal(&error))?;
    let console = agent.console;
    *AGENT_TERMINAL.lock().unwrap() = Some(console);
    Ok(HeldAgent {
        pid: agent.pid,
        wait: agent.waiter(),
        // Taken under the lock, so a `resize` in flight finishes before the handle is closed
        // and a later one finds the terminal absent.
        after_exit: Some(Box::new(|| {
            let console = AGENT_TERMINAL.lock().unwrap().take();
            if let Some(console) = console {
                conpty::close(console);
            }
        })),
        stdin: Some(Box::new(agent.input)),
        outputs: vec![(Box::new(agent.output), b'o')],
    })
}
static OPS_SOCKET_PATH: Mutex<Option<String>> = Mutex::new(None);

pub(crate) fn workspace_ops_socket_path(socket: &str) -> String {
    format!("{socket}.ops")
}

fn remove_session_mcp_paths(socket: &str) {
    platform::remove_socket_path(&session_mcp::socket_path(socket));
    let _ = std::fs::remove_file(session_mcp::context_path(socket));
}

fn listener_cleanup_and_exit() -> ! {
    if let Some(socket) = SOCKET_PATH.lock().unwrap().as_deref() {
        remove_session_mcp_paths(socket);
    }
    for path in [SOCKET_PATH.lock().unwrap().take(), OPS_SOCKET_PATH.lock().unwrap().take()].into_iter().flatten() {
        platform::remove_socket_path(&path);
    }
    std::process::exit(0);
}

/// Operations a workspace client may use: its own streams only. The Agent's stdio
/// (`i`/`c`), its process (`signal`), its state (`status`/`meta`) and its output are
/// never reachable from this socket.
const WORKSPACE_OPS: [&str; 7] = ["spawn", "kill", "which", "pty", "resize", "watch", "loopback-listen"];

struct WorkspaceStdout;
impl Write for WorkspaceStdout {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> { std::io::stdout().write(bytes) }
    fn flush(&mut self) -> std::io::Result<()> { std::io::stdout().flush() }
}
impl outbox::ClientWriter for WorkspaceStdout { fn close(&mut self) {} }

/// Finite pre-Session workspace work uses the same operations and frames as a
/// held Session, without creating an Agent or a reconnectable socket.
fn serve_workspace_stdio(reader: Box<dyn Read + Send>, writer: Box<dyn outbox::ClientWriter>) {
    let outbox = Arc::new(Outbox::new());
    let hello = |replay_from: u64| json!({ "protocol": frame::PROTOCOL_VERSION,
        "holderPid": std::process::id(), "role": "workspace", "replayFrom": replay_from }).to_string().into_bytes();
    if let Some(generation) = outbox.attach(writer, hello) {
        serve_workspace_client(reader, generation, outbox);
    }
}

fn serve_workspace_client(mut reader: Box<dyn Read + Send>, generation: u64, outbox: Arc<Outbox>) {
    let streams: Arc<streams::Streams> = Arc::default();
    let exit = Arc::new(Mutex::new(None));
    let meta = Arc::new(Mutex::new(Value::Null));
    while let Ok(Some((kind, payload))) = frame::read_frame(&mut reader) {
        match kind {
            b'a' if payload.len() == 8 => outbox.ack(u64::from_be_bytes(payload[..8].try_into().unwrap())),
            b'I' => streams.write(&payload),
            b'C' => streams.close_stdin(&payload),
            b'q' => {
                let reply = workspace_operation(&payload, &exit, &meta, &streams, &outbox);
                outbox.reply(generation, reply.to_string().as_bytes());
            }
            _ => {}
        }
    }
    // A workspace client's processes live only as long as its connection.
    streams.terminate_all();
    outbox.detach(generation);
}

fn workspace_operation(payload: &[u8], exit: &Arc<Mutex<Option<Value>>>, meta: &Arc<Mutex<Value>>,
    streams: &Arc<streams::Streams>, outbox: &Arc<Outbox>) -> Value {
    let request: Value = serde_json::from_slice(payload).unwrap_or(Value::Null);
    let op = request.get("op").and_then(Value::as_str).unwrap_or("");
    if !WORKSPACE_OPS.contains(&op) {
        return json!({ "id": request.get("id").cloned().unwrap_or(Value::Null), "ok": false, "error": "forbidden_for_workspace_client" });
    }
    // Agent pid 0: no workspace op reaches the Agent's process group.
    operation(payload, 0, exit, meta, streams, outbox)
}

fn pump<R: Read + Send + 'static>(mut reader: R, kind: u8, outbox: Arc<Outbox>) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => outbox.send(kind, &buffer[..n]),
            }
        }
    })
}

fn serve_client(
    mut reader: Box<dyn Read + Send>,
    generation: u64,
    outbox: Arc<Outbox>,
    stdin: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
    agent_pid: u32,
    exit: Arc<Mutex<Option<Value>>>,
    meta: Arc<Mutex<Value>>,
    streams: Arc<streams::Streams>,
) {
    while let Ok(Some((kind, payload))) = frame::read_frame(&mut reader) {
        match kind {
            b'i' => {
                if let Some(pipe) = stdin.lock().unwrap().as_mut() {
                    let _ = pipe.write_all(&payload).and_then(|_| pipe.flush());
                }
            }
            b'c' => {
                stdin.lock().unwrap().take();
            }
            b'a' if payload.len() == 8 => outbox.ack(u64::from_be_bytes(payload[..8].try_into().unwrap())),
            b'I' => streams.write(&payload),
            b'C' => streams.close_stdin(&payload),
            b'q' => {
                let reply = operation(&payload, agent_pid, &exit, &meta, &streams, &outbox);
                outbox.reply(generation, reply.to_string().as_bytes());
            }
            _ => {}
        }
    }
    outbox.detach(generation);
}

/// The extensible operation set. Workspace operations join this match later.
fn operation(
    payload: &[u8],
    agent_pid: u32,
    exit: &Arc<Mutex<Option<Value>>>,
    meta: &Arc<Mutex<Value>>,
    streams: &Arc<streams::Streams>,
    outbox: &Arc<Outbox>,
) -> Value {
    let request: Value = serde_json::from_slice(payload).unwrap_or(Value::Null);
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    match request.get("op").and_then(Value::as_str) {
        Some("signal") => {
            let signal = request.get("signal").and_then(Value::as_str).unwrap_or("TERM");
            match platform::signal_agent_group(agent_pid, signal) {
                Ok(()) => json!({ "id": id, "ok": true }),
                Err(error) => json!({ "id": id, "ok": false, "error": error }),
            }
        }
        Some("status") => json!({
            "id": id,
            "ok": true,
            "agentPid": agent_pid,
            "holderPid": std::process::id(),
            "exit": exit.lock().unwrap().clone(),
        }),
        Some("meta") => {
            *meta.lock().unwrap() = request.get("value").cloned().unwrap_or(Value::Null);
            json!({ "id": id, "ok": true })
        }
        Some("spawn") => match streams.spawn(&request, outbox) {
            Ok(value) => json!({ "id": id, "ok": true, "value": value }),
            Err(code) => json!({ "id": id, "ok": false, "code": code }),
        },
        Some("loopback-listen") => match loopback::listen(streams, outbox) {
            Ok(value) => json!({ "id": id, "ok": true, "value": value }),
            Err(code) => json!({ "id": id, "ok": false, "code": code }),
        },
        Some("kill") => match streams.kill(&request) {
            Ok(()) => json!({ "id": id, "ok": true }),
            Err(error) => json!({ "id": id, "ok": false, "error": error }),
        },
        Some("pty") => match terminal::spawn_pty(streams, &request, outbox) {
            Ok(value) => json!({ "id": id, "ok": true, "value": value }),
            Err(code) => json!({ "id": id, "ok": false, "code": code }),
        },
        // Without a stream: the held Agent's own terminal (primary client only; a
        // workspace client has no Agent, `agent_pid` 0).
        Some("resize") if request.get("stream").is_none() && agent_pid != 0 => match resize_agent_terminal(&request) {
            Ok(()) => json!({ "id": id, "ok": true }),
            Err(code) => json!({ "id": id, "ok": false, "code": code }),
        },
        Some("resize") => match terminal::resize(streams, &request) {
            Ok(()) => json!({ "id": id, "ok": true }),
            Err(code) => json!({ "id": id, "ok": false, "code": code }),
        },
        Some("watch") => match terminal::spawn_watch(streams, &request, outbox) {
            Ok(value) => json!({ "id": id, "ok": true, "value": value }),
            Err(code) => json!({ "id": id, "ok": false, "code": code }),
        },
        Some("which") => json!({
            "id": id,
            "ok": true,
            "value": request.get("command").and_then(Value::as_str).and_then(streams::which),
        }),
        _ => json!({ "id": id, "ok": false, "error": "unknown_op" }),
    }
}

fn resize_agent_terminal(request: &Value) -> Result<(), &'static str> {
    // Held for the call: the Windows pseudoconsole handle is closed once the Agent exited.
    let terminal = AGENT_TERMINAL.lock().unwrap();
    let master = terminal.ok_or("agent_terminal_absent")?;
    let size = |key: &str| request.get(key).and_then(Value::as_u64).and_then(|value| u16::try_from(value).ok()).filter(|value| *value > 0);
    let (Some(cols), Some(rows)) = (size("cols"), size("rows")) else { return Err("invalid_request") };
    #[cfg(unix)]
    {
        terminal::set_size(master as i32, cols, rows)
    }
    #[cfg(windows)]
    {
        conpty::resize(master, cols, rows)
    }
}

fn attach(socket: &str) {
    let (mut from_holder, mut to_holder) = match platform::connect(socket) {
        Ok(connection) => connection,
        Err(error) => {
            eprintln!("happier-session-holder: cannot attach: {error}");
            std::process::exit(1);
        }
    };
    // Some exec channels (e.g. `coder ssh`) never close our stdin when their
    // client dies, so the stdin copy may block forever. The holder side decides:
    // once the holder closes this connection (a newer client replaced it, or the
    // holder left), this process exits instead of lingering.
    thread::spawn(move || {
        let _ = std::io::copy(&mut std::io::stdin().lock(), &mut to_holder);
        to_holder.close();
    });
    // Rust's stdout is line-buffered; binary frames carry no newline, so each
    // chunk is flushed as it arrives or the exec channel would see it late.
    let mut stdout = std::io::stdout().lock();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        match from_holder.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
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

    #[test]
    fn meta_op_replaces_the_stored_value_and_unknown_ops_are_refused() {
        let exit = Arc::new(Mutex::new(None));
        let meta = Arc::new(Mutex::new(Value::Null));
        let streams: Arc<streams::Streams> = Arc::default();
        let outbox = Arc::new(Outbox::new());
        let reply = operation(br#"{"id":"1","op":"meta","value":{"v":1,"nextId":7}}"#, 1, &exit, &meta, &streams, &outbox);
        assert_eq!(reply, json!({ "id": "1", "ok": true }));
        assert_eq!(*meta.lock().unwrap(), json!({ "v": 1, "nextId": 7 }));
        operation(br#"{"id":"2","op":"meta","value":{"v":1,"nextId":9}}"#, 1, &exit, &meta, &streams, &outbox);
        assert_eq!(*meta.lock().unwrap(), json!({ "v": 1, "nextId": 9 }));
        assert_eq!(operation(br#"{"id":"3","op":"nope"}"#, 1, &exit, &meta, &streams, &outbox)["error"], "unknown_op");
    }

    #[test]
    fn serve_takes_its_options_once_each_before_the_agent_argv() {
        let args = |items: &[&str]| items.iter().map(|item| item.to_string()).collect::<Vec<_>>();
        let parsed = parse_serve(&args(&["--socket", "/s", "--session-mcp", "--", "agent", "--session-mcp"])).unwrap();
        assert_eq!((parsed.socket.as_str(), parsed.session_mcp, parsed.verbatim, parsed.argv), ("/s", true, false, args(&["agent", "--session-mcp"])));
        let parsed = parse_serve(&args(&["--socket", "/s", "--windows-verbatim", "--", "agent"])).unwrap();
        assert!(parsed.verbatim && !parsed.session_mcp);
        assert!(parse_serve(&args(&["--socket", "/s", "--session-mcp", "--session-mcp", "--", "agent"])).is_none());
        assert!(parse_serve(&args(&["--socket", "/s", "--other", "--", "agent"])).is_none());
        assert!(parse_serve(&args(&["--socket", "/s", "--"])).is_none());
        let parsed = parse_serve(&args(&["--socket", "/s", "--pty", "120x40", "--", "agent"])).unwrap();
        assert_eq!(parsed.pty, Some((120, 40)));
        let refusals: [&[&str]; 4] = [&["--pty", "0x40"], &["--pty", "120"], &["--pty"], &["--pty", "1x1", "--pty", "1x1"]];
        for refused in refusals {
            let mut items = vec!["--socket", "/s"];
            items.extend_from_slice(refused);
            items.extend_from_slice(&["--", "agent"]);
            assert!(parse_serve(&args(&items)).is_none(), "{refused:?}");
        }
    }
}

#[cfg(all(test, unix))]
mod stream_tests {
    use super::*;
    use crate::frame::read_frame;
    use crate::outbox::ClientWriter;
    use std::sync::Mutex as StdMutex;

    #[derive(Clone, Default)]
    struct Sink(Arc<StdMutex<Vec<u8>>>);
    impl Write for Sink {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl ClientWriter for Sink {
        fn close(&mut self) {}
    }

    #[test]
    fn spawned_stream_output_and_exit_are_sequenced_on_the_channel() {
        let exit = Arc::new(Mutex::new(None));
        let meta = Arc::new(Mutex::new(Value::Null));
        let streams: Arc<streams::Streams> = Arc::default();
        let outbox = Arc::new(Outbox::new());
        let sink = Sink::default();
        outbox.attach(Box::new(sink.clone()), |_| b"{}".to_vec()).unwrap();
        let reply = operation(br#"{"id":"s","op":"spawn","argv":["sh","-c","read line; echo got:$line"]}"#, 1, &exit, &meta, &streams, &outbox);
        let stream = reply["value"]["stream"].as_u64().unwrap() as u32;
        let mut input = stream.to_be_bytes().to_vec();
        input.extend_from_slice(b"hi\n");
        streams.write(&input);
        streams.close_stdin(&stream.to_be_bytes());
        let mut seen = String::new();
        for _ in 0..200 {
            let bytes = sink.0.lock().unwrap().clone();
            let mut reader = bytes.as_slice();
            seen.clear();
            let mut exited = false;
            while let Some((kind, payload)) = read_frame(&mut reader).unwrap() {
                if kind == b'O' { seen.push_str(&String::from_utf8_lossy(&payload[12..])); }
                if kind == b'X' { exited = true; }
            }
            if exited { break; }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(seen, "got:hi\n");
        let which = operation(br#"{"id":"w","op":"which","command":"sh"}"#, 1, &exit, &meta, &streams, &outbox);
        assert!(which["value"].as_str().is_some());
        let refused = operation(br#"{"id":"c","op":"spawn","argv":["sh"],"cwd":"../.."}"#, 1, &exit, &meta, &streams, &outbox);
        assert_eq!(refused["code"], "workspace_root_unsafe");
    }

    fn frames_for(sink: &Sink, stream: u32) -> (String, bool) {
        let bytes = sink.0.lock().unwrap().clone();
        let mut reader = bytes.as_slice();
        let (mut seen, mut exited) = (String::new(), false);
        while let Some((kind, payload)) = read_frame(&mut reader).unwrap() {
            if (kind == b'O' || kind == b'X') && payload.len() >= 12 && u32::from_be_bytes(payload[8..12].try_into().unwrap()) == stream {
                if kind == b'O' { seen.push_str(&String::from_utf8_lossy(&payload[12..])); } else { exited = true; }
            }
        }
        (seen, exited)
    }

    #[test]
    fn workspace_loopback_listener_carries_socket_bytes_and_ends_with_its_channel() {
        let exit = Arc::new(Mutex::new(None));
        let meta = Arc::new(Mutex::new(Value::Null));
        let streams: Arc<streams::Streams> = Arc::default();
        let outbox = Arc::new(Outbox::new());
        let sink = Sink::default();
        outbox.attach(Box::new(sink.clone()), |_| b"{}".to_vec()).unwrap();
        let reply = workspace_operation(br#"{"id":"p","op":"loopback-listen"}"#, &exit, &meta, &streams, &outbox);
        assert_eq!(reply["ok"], true, "{reply}");
        let listener = reply["value"]["stream"].as_u64().unwrap() as u32;
        let origin = reply["value"]["origin"].as_str().unwrap();
        // Derived from the listener's actual address: binding 0.0.0.0 fails this assertion.
        let address = origin.strip_prefix("http://127.0.0.1:").unwrap();
        let address = format!("127.0.0.1:{address}");
        let mut socket = std::net::TcpStream::connect(&address).unwrap();
        socket.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
        let accepted = wait_for(&sink, listener, |bytes, _| bytes.ends_with('\n')).0;
        let connection = serde_json::from_str::<Value>(&accepted).unwrap()["stream"].as_u64().unwrap() as u32;
        socket.write_all(b"request\0bytes").unwrap();
        assert_eq!(wait_for(&sink, connection, |bytes, _| bytes == "request\0bytes").0, "request\0bytes");
        streams.write(&streams::tagged(connection, b"response\0bytes"));
        let mut response = [0u8; 14];
        socket.read_exact(&mut response).unwrap();
        assert_eq!(&response, b"response\0bytes");
        streams.close_stdin(&connection.to_be_bytes());
        assert_eq!(socket.read(&mut [0]).unwrap(), 0);
        streams.terminate_all();
        assert!(wait_for(&sink, listener, |_, exited| exited).1);
        assert!(std::net::TcpStream::connect(&address).is_err());
    }

    fn wait_for(sink: &Sink, stream: u32, done: impl Fn(&str, bool) -> bool) -> (String, bool) {
        for _ in 0..300 {
            let (seen, exited) = frames_for(sink, stream);
            if done(&seen, exited) { return (seen, exited); }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        frames_for(sink, stream)
    }

    #[test]
    fn workspace_client_cannot_reach_the_agent_but_runs_its_own_streams() {
        let exit = Arc::new(Mutex::new(None));
        let meta = Arc::new(Mutex::new(serde_json::json!({ "role": "primary", "secret": "adopt-state" })));
        let streams: Arc<streams::Streams> = Arc::default();
        let outbox = Arc::new(Outbox::new());
        let sink = Sink::default();
        outbox.attach(Box::new(sink.clone()), |_| b"{}".to_vec()).unwrap();
        for forbidden in [r#"{"id":"1","op":"signal","signal":"KILL"}"#, r#"{"id":"2","op":"status"}"#, r#"{"id":"3","op":"meta","value":null}"#, r#"{"id":"4","op":"nope"}"#] {
            let reply = workspace_operation(forbidden.as_bytes(), &exit, &meta, &streams, &outbox);
            assert_eq!(reply["error"], "forbidden_for_workspace_client", "{forbidden}");
        }
        // The stored adopt state was not replaced by the refused `meta`.
        assert_eq!(meta.lock().unwrap()["secret"], "adopt-state");
        let reply = workspace_operation(br#"{"id":"s","op":"spawn","argv":["sh","-c","echo ws"]}"#, &exit, &meta, &streams, &outbox);
        let stream = reply["value"]["stream"].as_u64().expect("workspace spawn") as u32;
        let (seen, exited) = wait_for(&sink, stream, |_, exited| exited);
        assert!(exited && seen == "ws\n", "{seen:?}");
        assert_eq!(workspace_ops_socket_path("/run/h.sock"), "/run/h.sock.ops");
    }

    #[test]
    fn workspace_stdio_serves_existing_frames_without_an_agent_or_socket() {
        let request = frame::encode(b'q', br#"{"id":"w","op":"which","command":"sh"}"#);
        let sink = Sink::default();
        serve_workspace_stdio(Box::new(std::io::Cursor::new(request)), Box::new(sink.clone()));
        let bytes = sink.0.lock().unwrap().clone();
        let mut reader = bytes.as_slice();
        let (kind, hello) = read_frame(&mut reader).unwrap().unwrap();
        assert_eq!(kind, b'H');
        let hello: Value = serde_json::from_slice(&hello).unwrap();
        assert_eq!(hello["role"], "workspace");
        assert!(hello.get("agentPid").is_none());
        let (kind, reply) = read_frame(&mut reader).unwrap().unwrap();
        assert_eq!(kind, b'r');
        let reply: Value = serde_json::from_slice(&reply).unwrap();
        assert_eq!(reply["ok"], true);
        assert!(reply["value"].as_str().is_some());
    }

    #[cfg(unix)]
    #[test]
    fn terminal_stream_is_a_tty_with_its_size_input_and_exit() {
        let exit = Arc::new(Mutex::new(None));
        let meta = Arc::new(Mutex::new(Value::Null));
        let streams: Arc<streams::Streams> = Arc::default();
        let outbox = Arc::new(Outbox::new());
        let sink = Sink::default();
        outbox.attach(Box::new(sink.clone()), |_| b"{}".to_vec()).unwrap();
        let reply = operation(br#"{"id":"p","op":"pty","argv":["sh","-c","test -t 0 && echo tty; stty size; read line; echo got:$line; exit 3"],"cols":101,"rows":33}"#, 1, &exit, &meta, &streams, &outbox);
        let stream = reply["value"]["stream"].as_u64().expect("pty stream") as u32;
        let (seen, _) = wait_for(&sink, stream, |seen, _| seen.contains("33 101"));
        assert!(seen.contains("tty") && seen.contains("33 101"), "{seen:?}");
        let resized = operation(format!(r#"{{"id":"r","op":"resize","stream":{stream},"cols":120,"rows":40}}"#).as_bytes(), 1, &exit, &meta, &streams, &outbox);
        assert_eq!(resized["ok"], true);
        let mut input = stream.to_be_bytes().to_vec();
        input.extend_from_slice(b"hello\r");
        streams.write(&input);
        let (seen, exited) = wait_for(&sink, stream, |_, exited| exited);
        assert!(exited && seen.contains("got:hello"), "{seen:?}");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn watch_stream_pushes_root_relative_changes_including_new_subdirectories() {
        let exit = Arc::new(Mutex::new(None));
        let meta = Arc::new(Mutex::new(Value::Null));
        let streams: Arc<streams::Streams> = Arc::default();
        let outbox = Arc::new(Outbox::new());
        let sink = Sink::default();
        outbox.attach(Box::new(sink.clone()), |_| b"{}".to_vec()).unwrap();
        // The holder's working directory is the Session root.
        let root = std::env::current_dir().unwrap().canonicalize().unwrap();
        let dir = tempfile_dir(&root);
        let relative = dir.strip_prefix(&root).unwrap().to_string_lossy().into_owned();
        let reply = operation(format!(r#"{{"id":"w","op":"watch","path":"{relative}","recursive":true}}"#).as_bytes(), 1, &exit, &meta, &streams, &outbox);
        let stream = reply["value"]["stream"].as_u64().expect("watch stream") as u32;
        std::fs::create_dir(dir.join("sub")).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(100));
        std::fs::write(dir.join("sub").join("a.txt"), b"x").unwrap();
        let (seen, _) = wait_for(&sink, stream, |seen, _| seen.contains("sub/a.txt"));
        assert!(seen.contains(&format!(r#""path":"{relative}/sub""#)) && seen.contains(&format!(r#""path":"{relative}/sub/a.txt""#)), "{seen:?}");
        let killed = operation(format!(r#"{{"id":"k","op":"kill","stream":{stream}}}"#).as_bytes(), 1, &exit, &meta, &streams, &outbox);
        assert_eq!(killed["ok"], true);
        let (_, exited) = wait_for(&sink, stream, |_, exited| exited);
        assert!(exited);
        let outside = operation(br#"{"id":"o","op":"watch","path":"../.."}"#, 1, &exit, &meta, &streams, &outbox);
        assert_eq!(outside["code"], "workspace_root_unsafe");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(target_os = "linux")]
    fn tempfile_dir(root: &std::path::Path) -> std::path::PathBuf {
        let dir = root.join(format!("target/watch-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
