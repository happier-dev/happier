//! Adapters for the actual Wry child store, never the Tauri shell's store.
use super::cookie_types::{CookieCompletion, LoginCookie, LoginImportCode};

pub(super) fn available() -> Result<(), LoginImportCode> {
    if cfg!(any(
        target_os = "macos",
        target_os = "windows",
        target_os = "linux"
    )) {
        Ok(())
    } else {
        Err(LoginImportCode::EngineUnsupported)
    }
}

#[cfg(all(
    test,
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
#[test]
fn native_cookie_adapter_available_on_supported_platforms() {
    assert_eq!(available(), Ok(()));
}

#[cfg(target_os = "macos")]
pub(super) fn set(
    webview: &wry::WebView,
    cookie: &LoginCookie,
    completion: CookieCompletion,
) -> Result<(), LoginImportCode> {
    use wry::WebViewExtMacOS;
    let store = unsafe {
        webview
            .webview()
            .configuration()
            .websiteDataStore()
            .httpCookieStore()
    };
    set_macos_cookie(&store, cookie, completion)
}

#[cfg(target_os = "macos")]
pub(super) fn set_macos_cookie(
    store: &objc2_web_kit::WKHTTPCookieStore,
    cookie: &LoginCookie,
    completion: CookieCompletion,
) -> Result<(), LoginImportCode> {
    use objc2::rc::Retained;
    use objc2_foundation::{NSArray, NSHTTPCookie};
    use std::{cell::RefCell, ptr::NonNull};
    let native_cookie = macos_cookie(cookie)?;
    let expected = cookie.clone();
    let read_store =
        unsafe { Retained::retain(store as *const _ as *mut objc2_web_kit::WKHTTPCookieStore) }
            .ok_or(LoginImportCode::DestinationUnavailable)?;
    let completion = RefCell::new(Some(completion));
    // WebKit's void write callback does not report OS normalization (including expiry
    // caps). Read the native result once rather than duplicating the OS's policy.
    let readback = block2::RcBlock::new(move |cookies: NonNull<NSArray<NSHTTPCookie>>| {
        let preserved = unsafe {
            cookies.as_ref().iter().any(|stored| {
                stored.name().to_string() == expected.name
                    && stored.domain().to_string() == expected.domain
                    && stored.path().to_string() == expected.path
                    && stored.value().to_string() == expected.value
                    && stored.isSecure() == expected.secure
                    && stored.isHTTPOnly() == expected.http_only
                    && stored
                        .expiresDate()
                        .map(|date| date.timeIntervalSince1970())
                        == expected.expires
                    && expected.same_site.is_none_or(|policy| {
                        use super::cookie_types::CookieSameSite;
                        let actual = stored.sameSitePolicy().map(|value| value.to_string());
                        match policy {
                            CookieSameSite::None => {
                                matches!(actual.as_deref(), None | Some("none"))
                            }
                            CookieSameSite::Lax => actual.as_deref() == Some("lax"),
                            CookieSameSite::Strict => actual.as_deref() == Some("strict"),
                        }
                    })
            })
        };
        if let Some(completion) = completion.borrow_mut().take() {
            // The OS may already have stored a normalized cookie. Do not delete it:
            // it could have replaced an existing cookie belonging to this profile.
            completion(if preserved {
                Ok(())
            } else {
                Err(LoginImportCode::SourceFormatUnsupported)
            });
        }
    });
    let callback = block2::RcBlock::new(move || unsafe {
        read_store.getAllCookies(&readback);
    });
    unsafe {
        store.setCookie_completionHandler(&native_cookie, Some(&callback));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn macos_cookie(
    cookie: &LoginCookie,
) -> Result<objc2::rc::Retained<objc2_foundation::NSHTTPCookie>, LoginImportCode> {
    use objc2::{rc::Retained, runtime::AnyObject};
    use objc2_foundation::{
        ns_string, NSDate, NSHTTPCookie, NSHTTPCookieDomain, NSHTTPCookieExpires, NSHTTPCookieName,
        NSHTTPCookiePath, NSHTTPCookiePropertyKey, NSHTTPCookieSecure, NSHTTPCookieValue,
        NSMutableDictionary, NSString,
    };
    validate_cookie_strings(cookie)?;
    let name = NSString::from_str(&cookie.name);
    let value = NSString::from_str(&cookie.value);
    let domain = NSString::from_str(&cookie.domain);
    let path = NSString::from_str(&cookie.path);
    unsafe {
        // Domain is deliberately the original string: a leading dot changes cookie scope.
        let properties: Retained<NSMutableDictionary<NSHTTPCookiePropertyKey, AnyObject>> =
            NSMutableDictionary::from_slices(
                &[
                    NSHTTPCookieName,
                    NSHTTPCookieValue,
                    NSHTTPCookieDomain,
                    NSHTTPCookiePath,
                ],
                &[&name, &value, &domain, &path],
            );
        properties.insert(
            NSHTTPCookieSecure,
            if cookie.secure {
                ns_string!("TRUE")
            } else {
                ns_string!("FALSE")
            },
        );
        properties.insert(
            ns_string!("HttpOnly"),
            if cookie.http_only {
                ns_string!("TRUE")
            } else {
                ns_string!("FALSE")
            },
        );
        if let Some(expires) = cookie.expires {
            if !expires.is_finite() {
                return Err(LoginImportCode::SourceFormatUnsupported);
            }
            properties.insert(
                NSHTTPCookieExpires,
                &*NSDate::dateWithTimeIntervalSince1970(expires),
            );
        }
        if let Some(same_site) = cookie.same_site {
            use super::cookie_types::CookieSameSite;
            properties.insert(
                ns_string!("SameSite"),
                match same_site {
                    CookieSameSite::None => ns_string!("none"),
                    CookieSameSite::Lax => ns_string!("lax"),
                    CookieSameSite::Strict => ns_string!("strict"),
                },
            );
        }
        NSHTTPCookie::cookieWithProperties(&properties).ok_or(LoginImportCode::ImportFailed)
    }
}

#[cfg(target_os = "windows")]
pub(super) fn set(
    webview: &wry::WebView,
    cookie: &LoginCookie,
    completion: CookieCompletion,
) -> Result<(), LoginImportCode> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_2, COREWEBVIEW2_COOKIE_SAME_SITE_KIND_LAX,
        COREWEBVIEW2_COOKIE_SAME_SITE_KIND_NONE, COREWEBVIEW2_COOKIE_SAME_SITE_KIND_STRICT,
    };
    use windows_core_061::{Interface, HSTRING};
    use wry::WebViewExtWindows;
    validate_cookie_strings(cookie)?;
    // This is Wry 0.55.1's COM ABI (0.61), independent of Tauri's shell ABI (0.62).
    let native = webview
        .webview()
        .cast::<ICoreWebView2_2>()
        .map_err(|_| LoginImportCode::EngineUnsupported)?;
    unsafe {
        let manager = native
            .CookieManager()
            .map_err(|_| LoginImportCode::EngineUnsupported)?;
        let native_cookie = manager
            .CreateCookie(
                &HSTRING::from(cookie.name.as_str()),
                &HSTRING::from(cookie.value.as_str()),
                &HSTRING::from(cookie.domain.as_str()),
                &HSTRING::from(cookie.path.as_str()),
            )
            .map_err(|_| LoginImportCode::ImportFailed)?;
        native_cookie
            .SetIsSecure(cookie.secure)
            .map_err(|_| LoginImportCode::ImportFailed)?;
        native_cookie
            .SetIsHttpOnly(cookie.http_only)
            .map_err(|_| LoginImportCode::ImportFailed)?;
        if let Some(expires) = cookie.expires {
            if !expires.is_finite() {
                return Err(LoginImportCode::SourceFormatUnsupported);
            }
            native_cookie
                .SetExpires(expires)
                .map_err(|_| LoginImportCode::ImportFailed)?;
        }
        if let Some(same_site) = cookie.same_site {
            use super::cookie_types::CookieSameSite;
            native_cookie
                .SetSameSite(match same_site {
                    CookieSameSite::None => COREWEBVIEW2_COOKIE_SAME_SITE_KIND_NONE,
                    CookieSameSite::Lax => COREWEBVIEW2_COOKIE_SAME_SITE_KIND_LAX,
                    CookieSameSite::Strict => COREWEBVIEW2_COOKIE_SAME_SITE_KIND_STRICT,
                })
                .map_err(|_| LoginImportCode::ImportFailed)?;
        }
        manager
            .AddOrUpdateCookie(&native_cookie)
            .map_err(|_| LoginImportCode::ImportFailed)?;
    }
    completion(Ok(()));
    Ok(())
}

#[cfg(target_os = "linux")]
pub(super) fn set(
    webview: &wry::WebView,
    cookie: &LoginCookie,
    completion: CookieCompletion,
) -> Result<(), LoginImportCode> {
    use webkit2gtk::{CookieManagerExt, WebViewExt, WebsiteDataManagerExt};
    use wry::WebViewExtUnix;
    let manager = webview
        .webview()
        .website_data_manager()
        .and_then(|store| store.cookie_manager())
        .ok_or(LoginImportCode::EngineUnsupported)?;
    let mut cookie = linux_cookie(cookie)?;
    manager.add_cookie(
        &mut cookie,
        None::<&soup::gio::Cancellable>,
        move |result| {
            completion(result.map_err(|_| LoginImportCode::ImportFailed));
        },
    );
    Ok(())
}

#[cfg(target_os = "linux")]
fn linux_cookie(cookie: &LoginCookie) -> Result<soup::Cookie, LoginImportCode> {
    validate_cookie_strings(cookie)?;
    // Soup distinguishes host-only from domain cookies by this exact domain string. Wry's
    // cookie::Cookie conversion removes its leading dot, so do not route through set_cookie.
    let mut native = soup::Cookie::new(
        &cookie.name,
        &cookie.value,
        &cookie.domain,
        &cookie.path,
        -1,
    );
    native.set_secure(cookie.secure);
    native.set_http_only(cookie.http_only);
    if let Some(expires) = cookie.expires {
        if !expires.is_finite() {
            return Err(LoginImportCode::SourceFormatUnsupported);
        }
        let expires = soup::glib::DateTime::from_unix_utc(expires.floor() as i64)
            .map_err(|_| LoginImportCode::SourceFormatUnsupported)?;
        native.set_expires(&expires);
    }
    if let Some(same_site) = cookie.same_site {
        use super::cookie_types::CookieSameSite;
        native.set_same_site_policy(match same_site {
            CookieSameSite::None => soup::SameSitePolicy::None,
            CookieSameSite::Lax => soup::SameSitePolicy::Lax,
            CookieSameSite::Strict => soup::SameSitePolicy::Strict,
        });
    }
    Ok(native)
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub(super) fn set(
    _webview: &wry::WebView,
    _cookie: &LoginCookie,
    _completion: CookieCompletion,
) -> Result<(), LoginImportCode> {
    Err(LoginImportCode::EngineUnsupported)
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::super::cookie_types::CookieSameSite;
    use super::*;

    #[test]
    #[ignore = "requires a GTK display; run with xvfb-run and --ignored --test-threads=1"]
    fn linux_cookie_import_preserves_native_attributes_and_leaves_other_profile_untouched() {
        use gtk::prelude::*;
        use webkit2gtk::{CookieManagerExt, WebViewExt, WebsiteDataManagerExt};
        use wry::WebViewBuilderExtUnix;

        gtk::init().expect("GTK display for the native cookie-store test");
        let profiles = tempfile::tempdir().unwrap();
        let mut selected_context = wry::WebContext::new(Some(profiles.path().join("selected")));
        let mut other_context = wry::WebContext::new(Some(profiles.path().join("other")));
        let window = gtk::Window::new(gtk::WindowType::Toplevel);
        let container = gtk::Fixed::new();
        window.add(&container);
        window.show_all();
        let selected = wry::WebViewBuilder::new_with_web_context(&mut selected_context)
            .with_media_capture_enabled(false)
            .build_gtk(&container)
            .unwrap();
        let other = wry::WebViewBuilder::new_with_web_context(&mut other_context)
            .with_media_capture_enabled(false)
            .build_gtk(&container)
            .unwrap();
        let manager = |view: &wry::WebView| {
            use wry::WebViewExtUnix;
            view.webview()
                .website_data_manager()
                .unwrap()
                .cookie_manager()
                .unwrap()
        };
        async fn write(view: &wry::WebView, cookie: &LoginCookie) {
            let (sender, receiver) = tokio::sync::oneshot::channel();
            set(
                view,
                cookie,
                Box::new(move |result| {
                    let _ = sender.send(result);
                }),
            )
            .unwrap();
            receiver.await.unwrap().unwrap();
        }
        let domain = LoginCookie {
            name: "session".into(),
            value: "selected-fixture".into(),
            domain: ".example.test".into(),
            path: "/account".into(),
            secure: true,
            http_only: true,
            expires: Some(2_000_000_000.0),
            same_site: Some(CookieSameSite::Strict),
        };
        let host = LoginCookie {
            name: "host_session".into(),
            domain: "example.test".into(),
            secure: false,
            http_only: false,
            expires: None,
            same_site: Some(CookieSameSite::Lax),
            ..domain.clone()
        };
        let unrestricted = LoginCookie {
            name: "cross_site_session".into(),
            domain: "example.test".into(),
            same_site: Some(CookieSameSite::None),
            ..domain.clone()
        };
        let selected_manager = manager(&selected);
        let other_manager = manager(&other);
        soup::glib::MainContext::default().block_on(async {
            write(
                &other,
                &LoginCookie {
                    value: "other-fixture".into(),
                    ..domain.clone()
                },
            )
            .await;
            write(&selected, &domain).await;
            write(&selected, &host).await;
            write(&selected, &unrestricted).await;
            let mut selected_cookies = selected_manager
                .cookies_future("https://example.test/account")
                .await
                .unwrap();
            assert_eq!(selected_cookies.len(), 3);
            let native_domain = selected_cookies
                .iter_mut()
                .find_map(|cookie| (cookie.name().as_deref() == Some("session")).then_some(cookie))
                .unwrap();
            assert_eq!(native_domain.domain().as_deref(), Some(".example.test"));
            assert_eq!(native_domain.value().as_deref(), Some("selected-fixture"));
            assert!(native_domain.is_secure());
            assert!(native_domain.is_http_only());
            assert_eq!(
                native_domain.same_site_policy(),
                soup::SameSitePolicy::Strict
            );
            assert_eq!(native_domain.expires().unwrap().to_unix(), 2_000_000_000);
            let native_host = selected_cookies
                .iter_mut()
                .find_map(|cookie| {
                    (cookie.name().as_deref() == Some("host_session")).then_some(cookie)
                })
                .unwrap();
            assert_eq!(native_host.domain().as_deref(), Some("example.test"));
            assert!(!native_host.is_secure());
            assert!(!native_host.is_http_only());
            assert_eq!(native_host.same_site_policy(), soup::SameSitePolicy::Lax);
            assert!(native_host.expires().is_none());
            let native_unrestricted = selected_cookies
                .iter_mut()
                .find_map(|cookie| {
                    (cookie.name().as_deref() == Some("cross_site_session")).then_some(cookie)
                })
                .unwrap();
            assert_eq!(
                native_unrestricted.domain().as_deref(),
                Some("example.test")
            );
            assert!(native_unrestricted.is_secure());
            assert!(native_unrestricted.is_http_only());
            assert_eq!(
                native_unrestricted.same_site_policy(),
                soup::SameSitePolicy::None
            );
            assert_eq!(
                native_unrestricted.expires().unwrap().to_unix(),
                2_000_000_000
            );
            let mut child_cookies = selected_manager
                .cookies_future("https://child.example.test/account")
                .await
                .unwrap();
            assert_eq!(child_cookies.len(), 1);
            assert_eq!(child_cookies[0].name().as_deref(), Some("session"));
            let mut other_cookies = other_manager
                .cookies_future("https://example.test/account")
                .await
                .unwrap();
            assert_eq!(other_cookies.len(), 1);
            assert_eq!(other_cookies[0].value().as_deref(), Some("other-fixture"));
        });
    }

    #[test]
    fn linux_cookie_preserves_scope_security_same_site_and_absolute_expiry() {
        let cookie = LoginCookie {
            name: "session".into(),
            value: "fixture".into(),
            domain: ".example.test".into(),
            path: "/account".into(),
            secure: true,
            http_only: true,
            expires: Some(2_000_000_000.0),
            same_site: Some(CookieSameSite::Strict),
        };
        let mut domain = linux_cookie(&cookie).unwrap();
        assert!(domain.domain_matches("child.example.test"));
        assert_eq!(domain.domain().as_deref(), Some(".example.test"));
        assert!(domain.is_secure());
        assert!(domain.is_http_only());
        assert_eq!(domain.same_site_policy(), soup::SameSitePolicy::Strict);
        assert_eq!(domain.expires().unwrap().to_unix(), 2_000_000_000);
        let mut host = linux_cookie(&LoginCookie {
            domain: "example.test".into(),
            secure: false,
            http_only: false,
            expires: None,
            same_site: Some(CookieSameSite::Lax),
            ..cookie.clone()
        })
        .unwrap();
        assert!(host.domain_matches("example.test"));
        assert!(!host.domain_matches("child.example.test"));
        assert!(!host.is_secure());
        assert!(!host.is_http_only());
        assert!(host.expires().is_none());
        assert_eq!(host.same_site_policy(), soup::SameSitePolicy::Lax);
        let mut unrestricted = linux_cookie(&LoginCookie {
            same_site: Some(CookieSameSite::None),
            ..cookie.clone()
        })
        .unwrap();
        assert_eq!(unrestricted.same_site_policy(), soup::SameSitePolicy::None);
        assert!(matches!(
            linux_cookie(&LoginCookie {
                value: "bad\0value".into(),
                ..cookie
            }),
            Err(LoginImportCode::SourceFormatUnsupported)
        ));
    }
}

fn validate_cookie_strings(cookie: &LoginCookie) -> Result<(), LoginImportCode> {
    // Native cookie string adapters must never truncate a value at an embedded NUL.
    if [&cookie.name, &cookie.value, &cookie.domain, &cookie.path]
        .iter()
        .any(|value| value.contains('\0'))
    {
        return Err(LoginImportCode::SourceFormatUnsupported);
    }
    Ok(())
}

#[cfg(all(test, target_os = "macos"))]
mod macos_tests {
    use super::super::cookie_types::CookieSameSite;
    use super::*;

    #[test]
    fn macos_cookie_keeps_native_scope_flags_same_site_and_expiry() {
        let cookie = LoginCookie {
            name: "session".into(),
            value: "fixture".into(),
            domain: ".example.test".into(),
            path: "/account".into(),
            secure: true,
            http_only: true,
            expires: Some(2_000_000_000.0),
            same_site: Some(CookieSameSite::Strict),
        };
        let native = macos_cookie(&cookie).unwrap();
        unsafe {
            assert_eq!(native.domain().to_string(), ".example.test");
            assert_eq!(native.path().to_string(), "/account");
            assert!(native.isSecure());
            assert!(native.isHTTPOnly());
            assert_eq!(
                native.expiresDate().unwrap().timeIntervalSince1970(),
                2_000_000_000.0
            );
            assert_eq!(native.sameSitePolicy().unwrap().to_string(), "strict");
            let host = macos_cookie(&LoginCookie {
                domain: "example.test".into(),
                expires: None,
                secure: false,
                http_only: false,
                same_site: Some(CookieSameSite::Lax),
                ..cookie.clone()
            })
            .unwrap();
            assert_eq!(host.domain().to_string(), "example.test");
            assert!(!host.isSecure());
            assert!(!host.isHTTPOnly());
            assert!(host.expiresDate().is_none());
            assert_eq!(host.sameSitePolicy().unwrap().to_string(), "lax");
            let unrestricted = macos_cookie(&LoginCookie {
                same_site: Some(CookieSameSite::None),
                ..cookie.clone()
            })
            .unwrap();
            let policy = unrestricted
                .sameSitePolicy()
                .map(|policy| policy.to_string());
            assert!(matches!(policy.as_deref(), None | Some("none")));
        }
        assert!(matches!(
            macos_cookie(&LoginCookie {
                value: "bad\0value".into(),
                ..cookie
            }),
            Err(LoginImportCode::SourceFormatUnsupported)
        ));
    }
}
