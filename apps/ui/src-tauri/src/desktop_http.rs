//! The desktop HTTP transport: every `http(s)` request the renderer makes on desktop.
//!
//! The renderer's owner is `apps/ui/sources/utils/platform/tauri/transferFetch.ts`; the Electron
//! target implements the same three commands in `apps/desktop/src/main/commands/httpTransport.ts`.
//!
//! One `desktop_http_fetch` invoke performs the request. The renderer sends the request as one raw
//! frame and the host answers with one raw frame, both `[u32 LE head length][head JSON][body bytes]`. A body the server declared small enough is in
//! that frame. A larger or open-ended body is held here and flows through
//! `desktop_http_read_body` into a channel, so streams, downloads and their progress keep working.
//! `desktop_http_cancel` ends a request at any phase. Requests are keyed by the calling webview and
//! a renderer-chosen id, so a cancel can address a request whose invoke has not answered yet.

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Response};
use tauri::{Runtime, State, Webview};
use tauri_plugin_http::reqwest::{
    self,
    header::{self, HeaderMap, HeaderName, HeaderValue},
    redirect::Policy,
    Method,
};
use tokio::sync::oneshot;

/// The largest declared body returned inside the fetch frame. Bigger or undeclared bodies stream,
/// so a download keeps incremental delivery and progress, and its consumer keeps its own size
/// bound, instead of the main process buffering the whole body first. API responses at boot are
/// kilobytes, far below this.
const INLINE_BODY_LIMIT: u64 = 1024 * 1024;

/// Statuses that never carry a body (https://fetch.spec.whatwg.org/#null-body-status).
const NULL_BODY_STATUSES: [u16; 5] = [101, 103, 204, 205, 304];

const CANCELLED: &str = "Request cancelled";
const USER_AGENT: &str = concat!("happier-desktop/", env!("CARGO_PKG_VERSION"));

/// Message trailers of the body channel: a data chunk ends with 0, the end of the body is `[1]`.
const CHUNK_MORE: u8 = 0;
const CHUNK_END: u8 = 1;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientConfig {
    method: String,
    url: url::Url,
    #[serde(default)]
    headers: Vec<(String, String)>,
    /// The frame's body bytes, never a JSON field.
    #[serde(skip)]
    data: Option<Vec<u8>>,
    /// `0` is the renderer's `redirect: 'manual'`; anything else follows redirects.
    #[serde(default)]
    max_redirections: Option<usize>,
}

/// The head of a request frame: the renderer's id for the request and what to send.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RequestFrameHead {
    request_id: u64,
    #[serde(flatten)]
    config: ClientConfig,
}

/// The request frame's bytes. The custom-protocol IPC delivers them raw; its postMessage fallback
/// delivers the same bytes as a JSON array.
fn request_frame_bytes(body: &InvokeBody) -> Result<std::borrow::Cow<'_, [u8]>, String> {
    match body {
        InvokeBody::Raw(bytes) => Ok(std::borrow::Cow::Borrowed(bytes)),
        InvokeBody::Json(value) => Vec::<u8>::deserialize(value)
            .map(std::borrow::Cow::Owned)
            .map_err(|error| format!("desktop_http_fetch expects a request frame: {error}")),
    }
}

/// Decodes `[u32 LE head length][head JSON][body bytes]`; an empty body is no body.
fn decode_request_frame(frame: &[u8]) -> Result<(u64, ClientConfig), String> {
    let malformed = || "desktop_http_fetch received a malformed request frame".to_owned();
    let head_length = frame.get(..4).and_then(|bytes| <[u8; 4]>::try_from(bytes).ok()).ok_or_else(malformed)?;
    let body_start = 4_usize.checked_add(u32::from_le_bytes(head_length) as usize).ok_or_else(malformed)?;
    let head = frame.get(4..body_start).ok_or_else(malformed)?;
    let RequestFrameHead { request_id, mut config } = serde_json::from_slice(head).map_err(|error| error.to_string())?;
    let body = &frame[body_start..];
    config.data = (!body.is_empty()).then(|| body.to_vec());
    Ok((request_id, config))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResponseHead {
    status: u16,
    status_text: String,
    url: String,
    headers: Vec<(String, String)>,
    /// The body is not in the frame: read it with `desktop_http_read_body`.
    streamed: bool,
}

type RequestKey = (String, u64);

/// A request between its fetch invoke and the end of its body. Dropping `cancel` (by removing the
/// entry) is the cancellation signal for whichever phase is running.
struct InFlight {
    _cancel: oneshot::Sender<()>,
    pending_body: Option<(reqwest::Response, oneshot::Receiver<()>)>,
}

struct Clients {
    follow: reqwest::Client,
    manual: reqwest::Client,
}

/// Managed state: one connection pool and cookie jar for the app, shared by every window.
#[derive(Default)]
pub struct DesktopHttp {
    clients: OnceLock<Result<Clients, String>>,
    requests: Mutex<HashMap<RequestKey, InFlight>>,
}

fn build_clients() -> Result<Clients, String> {
    let jar = std::sync::Arc::new(reqwest::cookie::Jar::default());
    let build = |policy: Policy| {
        reqwest::Client::builder()
            .cookie_provider(jar.clone())
            .redirect(policy)
            .build()
            .map_err(|error| format!("desktop HTTP client unavailable: {error}"))
    };
    Ok(Clients { follow: build(Policy::default())?, manual: build(Policy::none())? })
}

// Forbidden request headers per https://fetch.spec.whatwg.org/#terminology-headers; the host
// owns them, as the browser would.
fn is_forbidden_header(name: &HeaderName) -> bool {
    matches!(
        *name,
        header::ACCEPT_CHARSET
            | header::ACCEPT_ENCODING
            | header::ACCESS_CONTROL_REQUEST_HEADERS
            | header::ACCESS_CONTROL_REQUEST_METHOD
            | header::CONNECTION
            | header::CONTENT_LENGTH
            | header::COOKIE
            | header::DATE
            | header::DNT
            | header::EXPECT
            | header::HOST
            | header::ORIGIN
            | header::REFERER
            | header::SET_COOKIE
            | header::TE
            | header::TRAILER
            | header::TRANSFER_ENCODING
            | header::UPGRADE
            | header::VIA
    ) || {
        let lower = name.as_str();
        lower.starts_with("proxy-") || lower.starts_with("sec-")
    }
}

fn request_headers(
    raw: Vec<(String, String)>,
    method: &Method,
    has_body: bool,
    origin: Option<&str>,
) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    for (name, value) in raw {
        let name = HeaderName::from_str(&name).map_err(|error| error.to_string())?;
        if is_forbidden_header(&name) {
            continue;
        }
        headers.append(name, HeaderValue::from_str(&value).map_err(|error| error.to_string())?);
    }
    // https://fetch.spec.whatwg.org/#http-network-or-cache-fetch: a bodiless POST/PUT still
    // declares its length, and a Range request asks for identity encoding.
    if !has_body && matches!(*method, Method::POST | Method::PUT) {
        headers.insert(header::CONTENT_LENGTH, HeaderValue::from_static("0"));
    }
    if headers.contains_key(header::RANGE) {
        headers.insert(header::ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    }
    if !headers.contains_key(header::USER_AGENT) {
        headers.insert(header::USER_AGENT, HeaderValue::from_static(USER_AGENT));
    }
    if let Some(origin) = origin {
        headers.insert(header::ORIGIN, HeaderValue::from_str(origin).map_err(|error| error.to_string())?);
    }
    Ok(headers)
}

/// Whether the body travels inside the fetch frame.
fn body_is_inline(method: &Method, status: u16, content_length: Option<u64>) -> bool {
    *method == Method::HEAD
        || NULL_BODY_STATUSES.contains(&status)
        || content_length.is_some_and(|length| length <= INLINE_BODY_LIMIT)
}

fn encode_frame(head: &ResponseHead, body: &[u8]) -> Result<Vec<u8>, String> {
    let head = serde_json::to_vec(head).map_err(|error| error.to_string())?;
    let head_length = u32::try_from(head.len()).map_err(|error| error.to_string())?;
    let mut frame = Vec::with_capacity(4 + head.len() + body.len());
    frame.extend_from_slice(&head_length.to_le_bytes());
    frame.extend_from_slice(&head);
    frame.extend_from_slice(body);
    Ok(frame)
}

fn response_head(response: &reqwest::Response, streamed: bool) -> Result<ResponseHead, String> {
    let status = response.status();
    let headers = response
        .headers()
        .iter()
        .map(|(name, value)| {
            String::from_utf8(value.as_bytes().to_vec())
                .map(|value| (name.as_str().to_owned(), value))
                .map_err(|error| error.to_string())
        })
        .collect::<Result<_, _>>()?;
    Ok(ResponseHead {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or_default().to_owned(),
        url: response.url().to_string(),
        headers,
        streamed,
    })
}

enum Fetched {
    Inline(Vec<u8>),
    Streamed(Vec<u8>, reqwest::Response),
}

impl DesktopHttp {
    fn clients(&self) -> Result<&Clients, String> {
        self.clients.get_or_init(build_clients).as_ref().map_err(Clone::clone)
    }

    fn requests(&self) -> std::sync::MutexGuard<'_, HashMap<RequestKey, InFlight>> {
        // A panic while holding the map cannot leave it inconsistent: every update is one insert
        // or remove.
        self.requests.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) async fn fetch(
        &self,
        key: RequestKey,
        origin: Option<&str>,
        config: ClientConfig,
    ) -> Result<Vec<u8>, String> {
        let ClientConfig { method, url, headers, data, max_redirections } = config;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(format!("desktop HTTP supports http and https only, not {}", url.scheme()));
        }
        let method = Method::from_bytes(method.as_bytes()).map_err(|error| error.to_string())?;
        let headers = request_headers(headers, &method, data.is_some(), origin)?;
        let clients = self.clients()?;
        let client = if max_redirections == Some(0) { &clients.manual } else { &clients.follow };
        let mut request = client.request(method.clone(), url).headers(headers);
        if let Some(data) = data {
            request = request.body(data);
        }

        let (cancel, mut cancelled) = oneshot::channel();
        self.requests().insert(key.clone(), InFlight { _cancel: cancel, pending_body: None });

        let exchange = async {
            let response = request.send().await.map_err(|error| error.to_string())?;
            let streamed = !body_is_inline(&method, response.status().as_u16(), response.content_length());
            let head = response_head(&response, streamed)?;
            if streamed {
                return Ok(Fetched::Streamed(encode_frame(&head, &[])?, response));
            }
            let body = response.bytes().await.map_err(|error| error.to_string())?;
            Ok::<_, String>(Fetched::Inline(encode_frame(&head, &body)?))
        };
        let outcome = tokio::select! {
            outcome = exchange => outcome,
            _ = &mut cancelled => Err(CANCELLED.to_owned()),
        };

        let mut requests = self.requests();
        match outcome {
            Ok(Fetched::Streamed(frame, response)) => match requests.get_mut(&key) {
                Some(entry) => {
                    entry.pending_body = Some((response, cancelled));
                    Ok(frame)
                }
                None => Err(CANCELLED.to_owned()),
            },
            Ok(Fetched::Inline(frame)) => {
                requests.remove(&key);
                Ok(frame)
            }
            Err(error) => {
                requests.remove(&key);
                Err(error)
            }
        }
    }

    /// Streams a held body as `chunk + [0]` messages followed by `[1]`.
    pub(crate) async fn read_body(
        &self,
        key: RequestKey,
        send: impl Fn(Vec<u8>) -> Result<(), String>,
    ) -> Result<(), String> {
        let pending = self.requests().get_mut(&key).and_then(|entry| entry.pending_body.take());
        let Some((mut response, mut cancelled)) = pending else {
            self.requests().remove(&key);
            return Err(format!("desktop_http_read_body: no streamed body for request {}", key.1));
        };
        let streamed = async {
            while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
                let mut message = Vec::with_capacity(chunk.len() + 1);
                message.extend_from_slice(&chunk);
                message.push(CHUNK_MORE);
                send(message)?;
            }
            send(vec![CHUNK_END])
        };
        let outcome = tokio::select! {
            outcome = streamed => outcome,
            _ = &mut cancelled => Err(CANCELLED.to_owned()),
        };
        self.requests().remove(&key);
        outcome
    }

    /// Ends a request in whichever phase it is; the running invoke rejects with `Request cancelled`.
    pub(crate) fn cancel(&self, key: &RequestKey) {
        self.requests().remove(key);
    }
}

fn request_key<R: Runtime>(webview: &Webview<R>, request_id: u64) -> RequestKey {
    (webview.label().to_owned(), request_id)
}

#[tauri::command]
pub async fn desktop_http_fetch<R: Runtime>(
    webview: Webview<R>,
    http: State<'_, DesktopHttp>,
    request: tauri::ipc::Request<'_>,
) -> Result<Response, String> {
    let (request_id, client_config) = decode_request_frame(&request_frame_bytes(request.body())?)?;
    // Same Origin the renderer's own document has, as a browser fetch would send.
    let origin = webview.url().ok().map(|url| url.origin().ascii_serialization());
    let frame = http.fetch(request_key(&webview, request_id), origin.as_deref(), client_config).await?;
    Ok(Response::new(frame))
}

#[tauri::command]
pub async fn desktop_http_read_body<R: Runtime>(
    webview: Webview<R>,
    http: State<'_, DesktopHttp>,
    request_id: u64,
    channel: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    http.read_body(request_key(&webview, request_id), |message| {
        channel.send(InvokeResponseBody::Raw(message)).map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub fn desktop_http_cancel<R: Runtime>(webview: Webview<R>, http: State<'_, DesktopHttp>, request_id: u64) {
    http.cancel(&request_key(&webview, request_id));
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Mutex;

    use super::*;

    /// A one-connection HTTP/1.1 server that answers with `response` and records the request.
    fn serve_once(response: Vec<u8>) -> (String, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let url = format!("http://{}/probe", listener.local_addr().expect("addr"));
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = Vec::new();
            let mut buffer = [0_u8; 8192];
            // Read the head and any declared body, which can arrive in a later segment.
            loop {
                let read = stream.read(&mut buffer).expect("read");
                request.extend_from_slice(&buffer[..read]);
                let text = String::from_utf8_lossy(&request).to_lowercase();
                let Some(head_end) = text.find("\r\n\r\n") else { if read == 0 { break } else { continue } };
                let declared = text.lines().find_map(|line| line.strip_prefix("content-length:"))
                    .and_then(|value| value.trim().parse::<usize>().ok()).unwrap_or(0);
                if read == 0 || request.len() >= head_end + 4 + declared { break; }
            }
            stream.write_all(&response).expect("write");
            String::from_utf8_lossy(&request).into_owned()
        });
        (url, handle)
    }

    fn config(url: &str) -> ClientConfig {
        ClientConfig {
            method: "GET".into(),
            url: url.parse().expect("url"),
            headers: vec![("x-probe".into(), "1".into()), ("cookie".into(), "dropped=1".into())],
            data: None,
            max_redirections: None,
        }
    }

    fn decode(frame: &[u8]) -> (serde_json::Value, Vec<u8>) {
        let length = u32::from_le_bytes(frame[..4].try_into().expect("length")) as usize;
        (serde_json::from_slice(&frame[4..4 + length]).expect("head"), frame[4 + length..].to_vec())
    }

    fn request_frame(head: serde_json::Value, body: &[u8]) -> Vec<u8> {
        let head = serde_json::to_vec(&head).expect("head");
        let mut frame = (head.len() as u32).to_le_bytes().to_vec();
        frame.extend_from_slice(&head);
        frame.extend_from_slice(body);
        frame
    }

    #[test]
    fn a_request_frame_carries_its_body_bytes_to_the_server() {
        let (url, server) = serve_once(b"HTTP/1.1 204 No Content\r\n\r\n".to_vec());
        let body = [0_u8, 255, 10, 13, 128];
        let frame = request_frame(serde_json::json!({ "requestId": 7, "method": "PUT", "url": url, "headers": [] }), &body);
        let (request_id, config) = decode_request_frame(&request_frame_bytes(&InvokeBody::Raw(frame)).expect("raw")).expect("decode");
        assert_eq!(request_id, 7);
        let http = DesktopHttp::default();
        tauri::async_runtime::block_on(http.fetch(("main".into(), request_id), None, config)).expect("fetch");
        let request = server.join().expect("server");
        assert!(request.to_lowercase().contains("content-length: 5"));
        assert!(request.ends_with(&*String::from_utf8_lossy(&body)), "the body bytes reach the server unchanged");
    }

    #[test]
    fn request_frames_decode_from_both_ipc_forms_and_refuse_truncation() {
        let frame = request_frame(serde_json::json!({ "requestId": 3, "method": "GET", "url": "https://example.test/", "maxRedirections": 0 }), b"");
        let json = InvokeBody::Json(serde_json::to_value(&frame).expect("json array"));
        let (request_id, config) = decode_request_frame(&request_frame_bytes(&json).expect("json")).expect("decode");
        assert_eq!((request_id, config.data, config.max_redirections), (3, None, Some(0)));
        assert!(decode_request_frame(&frame[..frame.len() - 1]).is_err());
        assert!(decode_request_frame(&[1, 0]).is_err());
    }

    #[test]
    fn a_declared_small_body_comes_back_in_the_one_fetch_frame() {
        let (url, server) = serve_once(
            b"HTTP/1.1 201 Created\r\ncontent-type: application/json\r\ncontent-length: 11\r\n\r\n{\"ok\":true}".to_vec(),
        );
        let http = DesktopHttp::default();
        let frame = tauri::async_runtime::block_on(http.fetch(("main".into(), 1), Some("tauri://localhost"), config(&url)))
            .expect("fetch");
        let (head, body) = decode(&frame);
        assert_eq!(head["status"], 201);
        assert_eq!(head["streamed"], false);
        assert!(head["headers"].as_array().expect("headers").iter().any(|pair| pair[0] == "content-type"));
        assert_eq!(body, b"{\"ok\":true}");
        assert!(http.requests().is_empty(), "an inline response leaves nothing held");

        let request = server.join().expect("server").to_lowercase();
        assert!(request.contains("x-probe: 1"));
        assert!(request.contains("origin: tauri://localhost"));
        assert!(!request.contains("dropped=1"), "forbidden headers belong to the host");
    }

    #[test]
    fn an_undeclared_body_streams_through_read_body_and_ends_with_the_end_marker() {
        let (url, server) = serve_once(
            b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n".to_vec(),
        );
        let http = DesktopHttp::default();
        let key: RequestKey = ("main".into(), 7);
        let frame = tauri::async_runtime::block_on(http.fetch(key.clone(), None, config(&url))).expect("fetch");
        let (head, body) = decode(&frame);
        assert_eq!(head["streamed"], true);
        assert!(body.is_empty());

        let messages = Mutex::new(Vec::<Vec<u8>>::new());
        tauri::async_runtime::block_on(http.read_body(key, |message| {
            messages.lock().expect("messages").push(message);
            Ok(())
        }))
        .expect("read body");
        let messages = messages.into_inner().expect("messages");
        assert_eq!(messages.last(), Some(&vec![CHUNK_END]));
        let bytes: Vec<u8> = messages[..messages.len() - 1]
            .iter()
            .flat_map(|message| {
                assert_eq!(message.last(), Some(&CHUNK_MORE));
                message[..message.len() - 1].to_vec()
            })
            .collect();
        assert_eq!(bytes, b"abcde");
        assert!(http.requests().is_empty());
        server.join().expect("server");
    }

    #[test]
    fn a_cancel_ends_a_held_body_and_frees_it() {
        let (url, server) = serve_once(b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n3\r\nabc\r\n".to_vec());
        let http = DesktopHttp::default();
        let key: RequestKey = ("main".into(), 9);
        tauri::async_runtime::block_on(http.fetch(key.clone(), None, config(&url))).expect("fetch");
        http.cancel(&key);
        let outcome = tauri::async_runtime::block_on(http.read_body(key, |_| Ok(())));
        assert!(outcome.is_err());
        assert!(http.requests().is_empty());
        server.join().expect("server");
    }

    #[test]
    fn bodies_are_inline_only_when_declared_small_or_absent() {
        assert!(body_is_inline(&Method::GET, 200, Some(INLINE_BODY_LIMIT)));
        assert!(!body_is_inline(&Method::GET, 200, Some(INLINE_BODY_LIMIT + 1)));
        assert!(!body_is_inline(&Method::GET, 200, None));
        assert!(body_is_inline(&Method::GET, 204, None));
        assert!(body_is_inline(&Method::HEAD, 200, Some(u64::MAX)));
    }
}
