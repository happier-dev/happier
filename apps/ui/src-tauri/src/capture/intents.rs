//! Native deep links carry an interactive intent, never targets or file access.
use url::Url;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeUrlIntent { Capture, MainWindow, Ignore }

pub fn classify(url: &Url) -> NativeUrlIntent {
    if !matches!(url.scheme(), "happier" | "happier-dev" | "happier-preview") {
        return NativeUrlIntent::Ignore;
    }
    let capture = url.host_str() == Some("capture")
        || (url.host_str().is_none() && matches!(url.path(), "/capture" | "/capture/"));
    if capture {
        if url.query().is_none() && url.fragment().is_none() && url.username().is_empty()
            && url.password().is_none() && url.port().is_none()
            && (url.host_str().is_none() || matches!(url.path(), "" | "/")) {
            NativeUrlIntent::Capture
        } else { NativeUrlIntent::Ignore }
    } else if url.host_str() == Some("notification-action") { NativeUrlIntent::Ignore }
    else { NativeUrlIntent::MainWindow }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capture_is_interactive_only_and_mixed_batches_keep_other_owners() {
        let urls = ["happier://capture", "happier-preview:///capture", "happier-dev://capture/",
            "happier://capture?target=private", "happier://capture/window", "https://capture",
            "happier://notification-action?payload=x", "happier://terminal?key=x", "happier:///session/kept"];
        assert_eq!(urls.map(|url| classify(&Url::parse(url).unwrap())), [
            NativeUrlIntent::Capture, NativeUrlIntent::Capture, NativeUrlIntent::Capture,
            NativeUrlIntent::Ignore, NativeUrlIntent::Ignore, NativeUrlIntent::Ignore,
            NativeUrlIntent::Ignore, NativeUrlIntent::MainWindow, NativeUrlIntent::MainWindow]);
    }
}
