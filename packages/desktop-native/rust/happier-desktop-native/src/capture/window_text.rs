//! One opt-in, selected-window accessibility traversal per capture. Providers
//! live only for that read; only sanitized text and native metadata are retained.
use super::{CancelSignal, CaptureSource, WindowDescriptor};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use xa11y_core::{App, ElementData, Provider, Role};

#[cfg(target_os = "linux")]
#[path = "window_text_linux.rs"]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::native_frontmost_context;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowTextScope {
    WholeFrontmostWindow,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AtspiWindowIdentity {
    pub bus_name: String,
    pub object_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrontmostWindowContext {
    pub process_id: u32,
    pub identity: AtspiWindowIdentity,
    pub app_name: Option<String>,
    pub window_title: Option<String>,
}

/// Metadata-only OS boundary. No Text/Value interface or window-descendant
/// snapshot is needed to retain the pre-portal ACTIVE window's identity.
#[cfg(any(target_os = "linux", test))]
trait FrontmostMetadata {
    fn children(
        &self,
        identity: &AtspiWindowIdentity,
    ) -> Result<Vec<AtspiWindowIdentity>, WindowTextUnavailable>;
    fn role(&self, identity: &AtspiWindowIdentity) -> Result<u32, WindowTextUnavailable>;
    fn active(&self, identity: &AtspiWindowIdentity) -> Result<bool, WindowTextUnavailable>;
    fn name(&self, identity: &AtspiWindowIdentity) -> Option<String>;
    fn process_id(&self, identity: &AtspiWindowIdentity) -> Option<u32>;
}

#[cfg(any(target_os = "linux", test))]
fn frontmost_context(metadata: &dyn FrontmostMetadata) -> Option<FrontmostWindowContext> {
    let registry = AtspiWindowIdentity {
        bus_name: "org.a11y.atspi.Registry".into(),
        object_path: "/org/a11y/atspi/accessible/root".into(),
    };
    let mut selected = None;
    for app in metadata.children(&registry).ok()? {
        let Ok(windows) = metadata.children(&app) else {
            continue;
        };
        for window in windows {
            // AT-SPI Role::{Dialog,FileChooser,Frame,Window}. Only inspect
            // top-level window metadata, never children of a window/control.
            if !matches!(metadata.role(&window), Ok(16 | 19 | 23 | 69))
                || metadata.active(&window) != Ok(true)
            {
                continue;
            }
            if selected.is_some() {
                return None;
            }
            let process_id = metadata.process_id(&app).filter(|pid| *pid > 0)?;
            if process_id == std::process::id() {
                return None;
            }
            let app_name = metadata
                .name(&app)
                .map(|name| xa11y_core::text::strip_bidi(&name));
            let window_title = metadata
                .name(&window)
                .map(|name| xa11y_core::text::strip_bidi(&name));
            selected = Some(FrontmostWindowContext {
                process_id,
                identity: window,
                app_name,
                window_title,
            });
        }
    }
    selected
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowTextUnavailable {
    NoWindowContext,
    PermissionRequired,
    TargetUnavailable,
    AmbiguousTarget,
    ProviderUnavailable,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowTextFailure {
    PermissionRequired,
    ProviderUnavailable,
    Cancelled,
}

impl From<WindowTextFailure> for WindowTextUnavailable {
    fn from(reason: WindowTextFailure) -> Self {
        match reason {
            WindowTextFailure::PermissionRequired => Self::PermissionRequired,
            WindowTextFailure::ProviderUnavailable => Self::ProviderUnavailable,
            WindowTextFailure::Cancelled => Self::Cancelled,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum WindowTextOutcome {
    Ready {
        text: String,
        source: Option<CaptureSource>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope: Option<WindowTextScope>,
    },
    Empty {
        source: Option<CaptureSource>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope: Option<WindowTextScope>,
    },
    Partial {
        text: String,
        reason: WindowTextFailure,
        source: Option<CaptureSource>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope: Option<WindowTextScope>,
    },
    Unavailable {
        reason: WindowTextUnavailable,
        source: Option<CaptureSource>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope: Option<WindowTextScope>,
    },
}

enum TextTarget {
    Native(WindowDescriptor),
    Frontmost(FrontmostWindowContext),
}

/// These are native accessibility operations, not substituted internal logic.
pub trait WindowAccessibility {
    fn windows(&self, process_id: u32) -> Result<Vec<ElementData>, WindowTextUnavailable>;
    fn children(&self, element: &ElementData) -> Result<Vec<ElementData>, WindowTextFailure>;
}

pub struct WindowText {
    target: Option<TextTarget>,
    source: Option<CaptureSource>,
    scope: Option<WindowTextScope>,
    cancel: CancelSignal,
    settled: Option<WindowTextOutcome>,
}

impl WindowText {
    /// Off captures retain metadata only. No xa11y operation runs here.
    pub fn new(
        target: Option<WindowDescriptor>,
        source: Option<CaptureSource>,
        cancel: CancelSignal,
    ) -> Self {
        Self {
            target: target.map(TextTarget::Native),
            source,
            scope: None,
            cancel,
            settled: None,
        }
    }
    pub fn from_frontmost(context: Option<FrontmostWindowContext>, cancel: CancelSignal) -> Self {
        let source = context.as_ref().map(|context| CaptureSource {
            app_name: context.app_name.clone(),
            window_title: context.window_title.clone(),
            window_id: None,
        });
        Self {
            target: context.map(TextTarget::Frontmost),
            source,
            scope: Some(WindowTextScope::WholeFrontmostWindow),
            cancel,
            settled: None,
        }
    }
    pub fn settled(&self) -> Option<WindowTextOutcome> {
        self.settled.clone()
    }
    /// Explicit reopen can enable an Off capture later. The caller holds this
    /// capture's mutex, so any cancelled earlier read has already stopped.
    /// Replacing its signal does not refresh an already-settled snapshot.
    pub fn resume(&mut self, cancel: CancelSignal) {
        self.cancel = cancel;
    }
    pub fn read_with(
        &mut self,
        connect: impl FnOnce() -> Result<Box<dyn WindowAccessibility>, WindowTextUnavailable>,
    ) -> WindowTextOutcome {
        if let Some(outcome) = &self.settled {
            return outcome.clone();
        }
        let unavailable = |reason| WindowTextOutcome::Unavailable {
            reason,
            source: self.source.clone(),
            scope: self.scope,
        };
        if self.cancel.is_cancelled() {
            return unavailable(WindowTextUnavailable::Cancelled);
        }
        let Some(target) = &self.target else {
            return unavailable(WindowTextUnavailable::NoWindowContext);
        };
        // No process-global provider/denial cache: a grant can recover before
        // this capture has performed its first traversal.
        let accessibility = match connect() {
            Ok(provider) => provider,
            Err(reason) => return unavailable(reason),
        };
        let pid = match target {
            TextTarget::Native(window) => window.process_id,
            TextTarget::Frontmost(context) => context.process_id,
        };
        let windows = match accessibility.windows(pid) {
            Ok(windows) => windows,
            Err(reason) => return unavailable(reason),
        };
        let window = match match target {
            TextTarget::Native(target) => select_window(target, windows),
            TextTarget::Frontmost(context) => select_frontmost_window(context, windows),
        } {
            Ok(window) => window,
            Err(reason) => return unavailable(reason),
        };
        let (text, failure) = traverse(accessibility.as_ref(), window, &self.cancel);
        let outcome = match (text.is_empty(), failure) {
            (true, Some(reason)) => unavailable(reason.into()),
            (false, Some(reason)) => WindowTextOutcome::Partial {
                text,
                reason,
                source: self.source.clone(),
                scope: self.scope,
            },
            (true, None) => WindowTextOutcome::Empty {
                source: self.source.clone(),
                scope: self.scope,
            },
            (false, None) => WindowTextOutcome::Ready {
                text,
                source: self.source.clone(),
                scope: self.scope,
            },
        };
        self.settled = Some(outcome.clone());
        outcome
    }
}

fn select_frontmost_window(
    context: &FrontmostWindowContext,
    windows: Vec<ElementData>,
) -> Result<ElementData, WindowTextUnavailable> {
    let mut matches = windows.into_iter().filter(|window| {
        window.pid == Some(context.process_id)
            && matches!(window.role, Role::Window | Role::Dialog)
            && window.raw.get("bus_name").and_then(|value| value.as_str())
                == Some(context.identity.bus_name.as_str())
            && window
                .raw
                .get("object_path")
                .and_then(|value| value.as_str())
                == Some(context.identity.object_path.as_str())
    });
    let first = matches
        .next()
        .ok_or(WindowTextUnavailable::TargetUnavailable)?;
    if matches.next().is_some() {
        Err(WindowTextUnavailable::AmbiguousTarget)
    } else {
        Ok(first)
    }
}

fn native_window_id(window: &ElementData) -> Option<u64> {
    // xa11y-windows 0.15.4's native HWND identity; AX/AT-SPI do not expose
    // the capture backend's native window id, so they use exact metadata below.
    window
        .stable_id
        .as_deref()?
        .strip_prefix("hwnd:0x")
        .and_then(|id| u64::from_str_radix(id, 16).ok())
}

fn select_window(
    target: &WindowDescriptor,
    windows: Vec<ElementData>,
) -> Result<ElementData, WindowTextUnavailable> {
    let windows: Vec<_> = windows
        .into_iter()
        .filter(|window| {
            window.pid == Some(target.process_id)
                && matches!(window.role, Role::Window | Role::Dialog)
        })
        .collect();
    let native_identity = windows
        .iter()
        .any(|window| native_window_id(window).is_some());
    let title = target.title.as_deref().map(xa11y_core::text::strip_bidi);
    let mut matches = windows.into_iter().filter(|window| {
        if native_identity {
            return native_window_id(window) == Some(u64::from(target.window_id));
        }
        let Some(bounds) = window.bounds else {
            return false;
        };
        // xa11y projects AX/AT-SPI bounds into integer desktop coordinates.
        bounds.x == target.frame.x as i32
            && bounds.y == target.frame.y as i32
            && bounds.width == target.frame.width as u32
            && bounds.height == target.frame.height as u32
            && title
                .as_deref()
                .is_none_or(|title| window.name.as_deref() == Some(title))
    });
    let first = matches
        .next()
        .ok_or(WindowTextUnavailable::TargetUnavailable)?;
    if matches.next().is_some() {
        Err(WindowTextUnavailable::AmbiguousTarget)
    } else {
        Ok(first)
    }
}

fn protected(element: &ElementData) -> bool {
    if ["ax_role", "ax_subrole"].iter().any(|key| {
        element.raw.get(*key).and_then(|value| value.as_str()) == Some("AXSecureTextField")
    }) || element
        .raw
        .get("atspi_role")
        .and_then(|value| value.as_str())
        .is_some_and(|role| role.eq_ignore_ascii_case("password text") || role == "role_num:40")
        || element
            .raw
            .get("IsPassword")
            .and_then(|value| value.as_bool())
            == Some(true)
    {
        return true;
    }
    // UIA implementations can expose only a masked edit value when xa11y
    // does not surface IsPassword. Omit the entire control, including its name.
    (element.states.editable || matches!(element.role, Role::TextField | Role::TextArea))
        && element.value.as_deref().is_some_and(|value| {
            !value.trim().is_empty()
                && value
                    .chars()
                    .all(|character| matches!(character, '*' | '•' | '●' | '▪' | '■' | '∙' | '◦'))
        })
}

fn exposed_text(element: &ElementData) -> Option<String> {
    if matches!(
        element.role,
        Role::Application
            | Role::Window
            | Role::Dialog
            | Role::Group
            | Role::WebArea
            | Role::ScrollBar
            | Role::ScrollThumb
            | Role::Separator
    ) {
        return None;
    }
    let name = element
        .name
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty());
    let text = if element.states.editable
        || matches!(
            element.role,
            Role::TextField
                | Role::TextArea
                | Role::StaticText
                | Role::Heading
                | Role::Link
                | Role::TableCell
                | Role::ComboBox
        ) {
        element
            .value
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .or(name)
    } else {
        name
    };
    text.map(str::to_owned)
}

fn traverse(
    provider: &dyn WindowAccessibility,
    root: ElementData,
    cancel: &CancelSignal,
) -> (String, Option<WindowTextFailure>) {
    enum Work {
        Visit(ElementData, bool),
        Finish {
            text: Option<String>,
            output_start: usize,
            omitted_start: usize,
            failures_start: usize,
        },
    }
    let mut work = vec![Work::Visit(root, true)];
    let mut output = Vec::new();
    let mut omitted = 0;
    let mut failures = 0;
    let mut failure = None;
    // Iterative traversal has no local depth/node/text cap and does not use
    // xa11y's tree() depth default. Every native child list is read at most once.
    while let Some(next) = work.pop() {
        if cancel.is_cancelled() {
            failure = Some(WindowTextFailure::Cancelled);
            break;
        }
        match next {
            Work::Visit(element, is_root) => {
                if protected(&element)
                    || (!is_root
                        && matches!(
                            element.role,
                            Role::Application | Role::Window | Role::Dialog
                        ))
                {
                    omitted += 1;
                    continue;
                }
                match provider.children(&element) {
                    Ok(children) => {
                        work.push(Work::Finish {
                            text: exposed_text(&element),
                            output_start: output.len(),
                            omitted_start: omitted,
                            failures_start: failures,
                        });
                        work.extend(
                            children
                                .into_iter()
                                .rev()
                                .map(|child| Work::Visit(child, false)),
                        );
                    }
                    Err(reason) => {
                        failures += 1;
                        failure.get_or_insert(reason);
                    }
                }
            }
            Work::Finish {
                text,
                output_start,
                omitted_start,
                failures_start,
            } => {
                // Prefer descendant text over repeated aggregate container text.
                // A parent aggregate must not disclose a protected/failed child.
                if output.len() == output_start
                    && omitted == omitted_start
                    && failures == failures_start
                {
                    if let Some(text) = text {
                        output.push(text);
                    }
                }
            }
        }
    }
    (output.join("\n"), failure)
}

fn native_failure(error: xa11y_core::Error) -> WindowTextFailure {
    match error {
        xa11y_core::Error::PermissionDenied { .. } => WindowTextFailure::PermissionRequired,
        _ => WindowTextFailure::ProviderUnavailable,
    }
}

struct NativeAccessibility(Arc<dyn Provider>);
impl WindowAccessibility for NativeAccessibility {
    fn windows(&self, process_id: u32) -> Result<Vec<ElementData>, WindowTextUnavailable> {
        let app = self.0.app_by_pid(process_id).map_err(|error| match error {
            xa11y_core::Error::SelectorNotMatched { .. } => {
                WindowTextUnavailable::TargetUnavailable
            }
            error => native_failure(error).into(),
        })?;
        // Core's existing App owner merges same-process registrations and
        // de-duplicates windows. It does not walk any window's content.
        App::windows_with(self.0.clone(), &app)
            .map(|windows| {
                windows
                    .into_iter()
                    .map(|window| window.data().clone())
                    .collect()
            })
            .map_err(|error| native_failure(error).into())
    }
    fn children(&self, element: &ElementData) -> Result<Vec<ElementData>, WindowTextFailure> {
        self.0.get_children(Some(element)).map_err(native_failure)
    }
}

pub fn native_accessibility() -> Result<Box<dyn WindowAccessibility>, WindowTextUnavailable> {
    #[cfg(target_os = "macos")]
    let provider: Arc<dyn Provider> = Arc::new(
        xa11y_macos::MacOSProvider::new()
            .map_err(|error| WindowTextUnavailable::from(native_failure(error)))?,
    );
    #[cfg(target_os = "windows")]
    let provider: Arc<dyn Provider> = Arc::new(
        xa11y_windows::WindowsProvider::new()
            .map_err(|error| WindowTextUnavailable::from(native_failure(error)))?,
    );
    #[cfg(target_os = "linux")]
    let provider: Arc<dyn Provider> = Arc::new(
        xa11y_linux::LinuxProvider::new()
            .map_err(|error| WindowTextUnavailable::from(native_failure(error)))?,
    );
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    return Err(WindowTextUnavailable::ProviderUnavailable);
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    Ok(Box::new(NativeAccessibility(provider)))
}

#[cfg(test)]
mod context_tests {
    use super::*;
    use std::sync::Mutex;

    fn identity(path: &str) -> AtspiWindowIdentity {
        AtspiWindowIdentity {
            bus_name: ":1.80".into(),
            object_path: path.into(),
        }
    }
    struct MetadataOs {
        active: bool,
        own_process: bool,
        calls: Mutex<Vec<String>>,
    }
    impl FrontmostMetadata for MetadataOs {
        fn children(
            &self,
            id: &AtspiWindowIdentity,
        ) -> Result<Vec<AtspiWindowIdentity>, WindowTextUnavailable> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("children:{}", id.object_path));
            match id.object_path.as_str() {
                "/org/a11y/atspi/accessible/root" => Ok(vec![identity("/app")]),
                "/app" => Ok(vec![
                    identity("/sibling"),
                    identity("/chosen"),
                    identity("/password"),
                ]),
                _ => panic!("metadata must never query window/control descendants"),
            }
        }
        fn role(&self, id: &AtspiWindowIdentity) -> Result<u32, WindowTextUnavailable> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("role:{}", id.object_path));
            Ok(if id.object_path == "/password" {
                40
            } else {
                23
            })
        }
        fn active(&self, id: &AtspiWindowIdentity) -> Result<bool, WindowTextUnavailable> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("state:{}", id.object_path));
            assert_ne!(id.object_path, "/password");
            Ok(self.active && id.object_path == "/chosen")
        }
        fn name(&self, id: &AtspiWindowIdentity) -> Option<String> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("name:{}", id.object_path));
            Some(
                match id.object_path.as_str() {
                    "/app" => "Native Wayland app",
                    "/chosen" => "Before portal",
                    _ => panic!("only chosen metadata is named"),
                }
                .into(),
            )
        }
        fn process_id(&self, id: &AtspiWindowIdentity) -> Option<u32> {
            assert_eq!(id.object_path, "/app");
            self.calls.lock().unwrap().push("pid".into());
            Some(if self.own_process {
                std::process::id()
            } else {
                80
            })
        }
    }
    #[test]
    fn preportal_metadata_is_structural_and_never_selects_happiers_own_process() {
        let mut metadata = MetadataOs {
            active: true,
            own_process: false,
            calls: Mutex::default(),
        };
        let context =
            frontmost_context(&metadata).expect("ACTIVE native Wayland window must be retained");
        assert_eq!(context.identity, identity("/chosen"));
        assert_eq!(context.window_title.as_deref(), Some("Before portal"));
        assert_eq!(
            metadata
                .calls
                .lock()
                .unwrap()
                .iter()
                .filter(|call| call.starts_with("children:"))
                .count(),
            2
        );
        metadata.active = false;
        assert_eq!(frontmost_context(&metadata), None);
        metadata.active = true;
        metadata.own_process = true;
        metadata.calls.lock().unwrap().clear();
        assert_eq!(frontmost_context(&metadata), None);
        assert!(
            !metadata
                .calls
                .lock()
                .unwrap()
                .iter()
                .any(|call| call.starts_with("name:")),
            "self is excluded by native PID before window-name/content collection"
        );
    }
}
