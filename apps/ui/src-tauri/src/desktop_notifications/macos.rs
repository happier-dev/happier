use std::{
    ptr::NonNull,
    sync::{Mutex, OnceLock},
};

use block2::{DynBlock, RcBlock};
use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{Bool, ProtocolObject},
    AnyThread,
};
use objc2_foundation::{
    NSArray, NSBundle, NSDictionary, NSError, NSObject, NSObjectProtocol, NSSet, NSString,
};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationAction,
    UNNotificationActionOptions, UNNotificationCategory, UNNotificationCategoryOptions,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};
use tauri::AppHandle;

use super::{emit_action, DesktopNotification};

static APP: OnceLock<AppHandle> = OnceLock::new();

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "HappierDesktopNotificationDelegate"]
    struct NotificationDelegate;

    unsafe impl NSObjectProtocol for NotificationDelegate {}

    unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            completion.call((UNNotificationPresentationOptions::Banner,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn respond(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion: &DynBlock<dyn Fn()>,
        ) {
            let action = response.actionIdentifier().to_string();
            let request = response.notification().request();
            if let Some(notification) = from_request(&request) {
                emit_action(
                    APP.get(),
                    &notification,
                    if action == "com.apple.UNNotificationDefaultActionIdentifier" {
                        "default"
                    } else {
                        &action
                    },
                );
            }
            completion.call(());
        }
    }
);

pub fn prepare() {
    if NSBundle::mainBundle().bundleIdentifier().is_none() {
        return;
    }
    static DELEGATE: OnceLock<Retained<NotificationDelegate>> = OnceLock::new();
    DELEGATE.get_or_init(|| {
        let this = NotificationDelegate::alloc().set_ivars(());
        // SAFETY: initialize the newly allocated NSObject subclass.
        let delegate: Retained<NotificationDelegate> = unsafe { msg_send![super(this), init] };
        UNUserNotificationCenter::currentNotificationCenter()
            .setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        delegate
    });
}

pub fn install(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

const ENVELOPE_KEY: &str = "happier.desktopNotification.v1";

fn make_content(notification: &DesktopNotification) -> Retained<UNMutableNotificationContent> {
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(&notification.title));
    content.setBody(&NSString::from_str(&notification.body));
    content.setCategoryIdentifier(&NSString::from_str("happier.guardStopWarning.v1"));
    let payload = NSString::from_str(
        &serde_json::to_string(notification).expect("JSON notification envelope"),
    );
    let user_info = NSDictionary::from_slices(&[&*NSString::from_str(ENVELOPE_KEY)], &[&*payload]);
    // SAFETY: UserNotifications accepts a property-list dictionary; both keys and values are NSString.
    let _: () = unsafe { msg_send![&content, setUserInfo: &*user_info] };
    content
}

fn from_request(request: &UNNotificationRequest) -> Option<DesktopNotification> {
    let value = request
        .content()
        .userInfo()
        .objectForKey(&NSString::from_str(ENVELOPE_KEY))?;
    let payload = value.downcast_ref::<NSString>()?;
    let notification: DesktopNotification = serde_json::from_str(&payload.to_string()).ok()?;
    (notification.identifier == request.identifier().to_string()).then_some(notification)
}

pub struct Presented {
    identifier: String,
}

pub async fn show(
    _app: &AppHandle,
    notification: &DesktopNotification,
) -> Result<Presented, String> {
    if NSBundle::mainBundle().bundleIdentifier().is_none() {
        return Err("notification_requires_app_bundle".into());
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let sender = Mutex::new(Some(sender));
    UNUserNotificationCenter::currentNotificationCenter()
        .requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert,
            &RcBlock::new(move |granted: Bool, _error: *mut NSError| {
                if let Some(sender) = sender.lock().unwrap().take() {
                    let _ = sender.send(granted.as_bool());
                }
            }),
        );
    if !receiver
        .await
        .map_err(|_| "notification_permission_unavailable")?
    {
        return Err("notification_permission_denied".into());
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    // Objective-C objects stay on this synchronous side of the IPC await.
    {
        let category_id = NSString::from_str("happier.guardStopWarning.v1");
        let actions = notification
            .actions
            .iter()
            .map(|action| {
                UNNotificationAction::actionWithIdentifier_title_options(
                    &NSString::from_str(&action.id),
                    &NSString::from_str(&action.title),
                    UNNotificationActionOptions::Foreground,
                )
            })
            .collect::<Vec<_>>();
        let category =
            UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(
                &category_id,
                &NSArray::from_retained_slice(&actions),
                &NSArray::new(),
                UNNotificationCategoryOptions::empty(),
            );
        let center = UNUserNotificationCenter::currentNotificationCenter();
        center.setNotificationCategories(&NSSet::from_retained_slice(&[category]));
        let content = make_content(notification);
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(&notification.identifier),
            &content,
            None,
        );
        let sender = Mutex::new(Some(sender));
        center.addNotificationRequest_withCompletionHandler(
            &request,
            Some(&RcBlock::new(move |error: *mut NSError| {
                if let Some(sender) = sender.lock().unwrap().take() {
                    let _ = sender.send(error.is_null());
                }
            })),
        );
    }
    if !receiver
        .await
        .map_err(|_| "notification_delivery_unavailable")?
    {
        return Err("notification_delivery_failed".into());
    }
    Ok(Presented {
        identifier: notification.identifier.clone(),
    })
}

impl Presented {
    pub async fn close(&self, _app: &AppHandle) -> Result<(), String> {
        remove(_app, &self.identifier).await
    }
}

pub async fn remove(_app: &AppHandle, identifier: &str) -> Result<(), String> {
    if NSBundle::mainBundle().bundleIdentifier().is_none() {
        return Err("notification_requires_app_bundle".into());
    }
    UNUserNotificationCenter::currentNotificationCenter()
        .removeDeliveredNotificationsWithIdentifiers(&NSArray::from_retained_slice(&[
            NSString::from_str(identifier),
        ]));
    Ok(())
}

pub async fn list(_app: &AppHandle) -> Result<Vec<DesktopNotification>, String> {
    if NSBundle::mainBundle().bundleIdentifier().is_none() {
        return Err("notification_requires_app_bundle".into());
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let sender = Mutex::new(Some(sender));
    UNUserNotificationCenter::currentNotificationCenter()
        .getDeliveredNotificationsWithCompletionHandler(&RcBlock::new(
            move |notifications: NonNull<NSArray<UNNotification>>| {
                // SAFETY: the native callback owns a non-null array for this invocation.
                let notifications = unsafe { notifications.as_ref() };
                let original = notifications
                    .iter()
                    .filter_map(|notification| from_request(&notification.request()))
                    .collect();
                if let Some(sender) = sender.lock().unwrap().take() {
                    let _ = sender.send(original);
                }
            },
        ));
    receiver
        .await
        .map_err(|_| "notification_list_unavailable".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delivered_content_recovers_the_original_envelope_without_process_state() {
        let original: DesktopNotification = serde_json::from_value(serde_json::json!({
            "identifier": "home:guard-stop:s:123", "accountId": "owner", "title": "Stopping", "body": "Finished",
            "data": { "serverId": "home", "accountId": "owner", "stopAt": 123 },
            "actions": [{ "id": "keep", "title": "Keep running" }]
        })).unwrap();
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(&original.identifier),
            &make_content(&original),
            None,
        );
        let recovered = from_request(&request);
        assert!(
            recovered.is_some(),
            "native content must retain the original occurrence after process exit"
        );
        assert_eq!(
            recovered.unwrap().response("keep"),
            original.response("keep")
        );
    }
}
