//! Main-thread composed test for the live macOS cookie adapter.
//! Run on macOS: HAPPIER_SKIP_HSETUP_SIDECAR_BUILD=true cargo run --example macos_cookie_store_test.
#[cfg(target_os = "macos")]
#[path = "../src/browser/cookie_store.rs"]
mod cookie_store;
#[cfg(target_os = "macos")]
#[path = "../src/browser/cookie_types.rs"]
mod cookie_types;

#[cfg(target_os = "macos")]
fn main() {
    use cookie_types::{CookieSameSite, LoginCookie};
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSApplication;
    use objc2_web_kit::WKWebsiteDataStore;

    let main_thread =
        MainThreadMarker::new().expect("the composed test must start on AppKit's main thread");
    let _application = NSApplication::sharedApplication(main_thread);
    let first = unsafe { WKWebsiteDataStore::nonPersistentDataStore(main_thread) };
    let second = unsafe { WKWebsiteDataStore::nonPersistentDataStore(main_thread) };
    let first_store = unsafe { first.httpCookieStore() };
    let second_store = unsafe { second.httpCookieStore() };
    assert!(read_cookies(&first_store).is_empty());
    assert!(read_cookies(&second_store).is_empty());

    let supported_expiry =
        unsafe { objc2_foundation::NSDate::date().timeIntervalSince1970() }.floor() + 86_400.0;
    let domain = LoginCookie {
        name: "domain_cookie".into(),
        value: "first-profile".into(),
        domain: ".example.test".into(),
        path: "/account".into(),
        secure: true,
        http_only: true,
        expires: Some(supported_expiry),
        same_site: Some(CookieSameSite::Strict),
    };
    write_cookie(&first_store, &domain);
    write_cookie(
        &first_store,
        &LoginCookie {
            name: "host_cookie".into(),
            domain: "example.test".into(),
            path: "/".into(),
            secure: false,
            http_only: false,
            expires: None,
            same_site: Some(CookieSameSite::Lax),
            ..domain.clone()
        },
    );
    write_cookie(
        &first_store,
        &LoginCookie {
            name: "unrestricted_cookie".into(),
            same_site: Some(CookieSameSite::None),
            ..domain.clone()
        },
    );
    let actual = read_cookies(&first_store);
    assert_eq!(actual.len(), 3);
    let stored_domain = actual
        .iter()
        .find(|cookie| cookie.name == "domain_cookie")
        .unwrap();
    assert_eq!(stored_domain.domain, ".example.test");
    assert_eq!(stored_domain.path, "/account");
    assert!(stored_domain.secure);
    assert!(stored_domain.http_only);
    assert_eq!(stored_domain.expires, Some(supported_expiry));
    assert_eq!(stored_domain.same_site.as_deref(), Some("strict"));
    let stored_host = actual
        .iter()
        .find(|cookie| cookie.name == "host_cookie")
        .unwrap();
    assert_eq!(stored_host.domain, "example.test");
    assert_eq!(stored_host.path, "/");
    assert!(!stored_host.secure);
    assert!(!stored_host.http_only);
    assert_eq!(stored_host.expires, None);
    assert_eq!(stored_host.same_site.as_deref(), Some("lax"));
    let unrestricted = actual
        .iter()
        .find(|cookie| cookie.name == "unrestricted_cookie")
        .unwrap();
    // WebKit/CFNetwork versions expose unrestricted policy as nil or "none".
    assert!(matches!(
        unrestricted.same_site.as_deref(),
        None | Some("none")
    ));
    assert!(read_cookies(&second_store).is_empty());

    write_cookie(
        &second_store,
        &LoginCookie {
            value: "second-profile".into(),
            ..domain.clone()
        },
    );
    let first_readback = read_cookies(&first_store);
    let first_cookie = first_readback
        .iter()
        .find(|cookie| cookie.name == "domain_cookie")
        .unwrap();
    assert_eq!(first_cookie.value, "first-profile");
    let second_readback = read_cookies(&second_store);
    assert_eq!(second_readback.len(), 1);
    assert_eq!(second_readback[0].value, "second-profile");
    // This macOS executor shortened long expiries to 400 days in the effect RED.
    // Detect that native normalization without encoding its cap in the adapter.
    let unsupported_expiry = LoginCookie {
        name: "unsupported_expiry".into(),
        expires: Some(supported_expiry + 800.0 * 86_400.0),
        ..domain
    };
    assert_eq!(
        write_cookie_result(&first_store, &unsupported_expiry),
        Err(cookie_types::LoginImportCode::SourceFormatUnsupported),
        "a silently shortened expiry is unsupported, not imported"
    );
    assert_eq!(read_cookies(&second_store).len(), 1);
    println!(
        "macOS WKHTTPCookieStore attributes, unsupported expiry, and profile isolation passed"
    );
}

#[cfg(target_os = "macos")]
#[derive(Debug)]
struct StoredCookie {
    name: String,
    value: String,
    domain: String,
    path: String,
    secure: bool,
    http_only: bool,
    expires: Option<f64>,
    same_site: Option<String>,
}

#[cfg(target_os = "macos")]
fn write_cookie(store: &objc2_web_kit::WKHTTPCookieStore, cookie: &cookie_types::LoginCookie) {
    write_cookie_result(store, cookie).expect("native cookie write should complete");
}

#[cfg(target_os = "macos")]
fn write_cookie_result(
    store: &objc2_web_kit::WKHTTPCookieStore,
    cookie: &cookie_types::LoginCookie,
) -> Result<(), cookie_types::LoginImportCode> {
    let (sender, receiver) = std::sync::mpsc::channel();
    cookie_store::set_macos_cookie(
        store,
        cookie,
        Box::new(move |result| {
            sender
                .send(result)
                .expect("composed test still awaits native completion");
        }),
    )
    .expect("native cookie construction should succeed");
    wait_for_native(receiver)
}

#[cfg(target_os = "macos")]
fn read_cookies(store: &objc2_web_kit::WKHTTPCookieStore) -> Vec<StoredCookie> {
    use objc2_foundation::{NSArray, NSHTTPCookie};
    let (sender, receiver) = std::sync::mpsc::channel();
    let callback =
        block2::RcBlock::new(move |cookies: std::ptr::NonNull<NSArray<NSHTTPCookie>>| {
            let cookies = unsafe { cookies.as_ref() };
            let snapshot = cookies
                .iter()
                .map(|cookie| unsafe {
                    StoredCookie {
                        name: cookie.name().to_string(),
                        value: cookie.value().to_string(),
                        domain: cookie.domain().to_string(),
                        path: cookie.path().to_string(),
                        secure: cookie.isSecure(),
                        http_only: cookie.isHTTPOnly(),
                        expires: cookie
                            .expiresDate()
                            .map(|date| date.timeIntervalSince1970()),
                        same_site: cookie.sameSitePolicy().map(|policy| policy.to_string()),
                    }
                })
                .collect();
            sender
                .send(snapshot)
                .expect("composed test still awaits cookie readback");
        });
    unsafe {
        store.getAllCookies(&callback);
    }
    wait_for_native(receiver)
}

#[cfg(target_os = "macos")]
fn wait_for_native<T>(receiver: std::sync::mpsc::Receiver<T>) -> T {
    use objc2_foundation::{NSDate, NSDefaultRunLoopMode, NSRunLoop};
    loop {
        match receiver.try_recv() {
            Ok(value) => return value,
            Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                panic!("native completion was dropped")
            }
            Err(std::sync::mpsc::TryRecvError::Empty) => unsafe {
                NSRunLoop::currentRunLoop()
                    .runMode_beforeDate(NSDefaultRunLoopMode, &NSDate::distantFuture());
            },
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn main() {
    panic!("macos_cookie_store_test requires macOS and its WebKit framework");
}
