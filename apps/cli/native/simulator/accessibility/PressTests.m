#import <XCTest/XCTest.h>

@interface HappierSimulatorPressTests : XCTestCase
@end
@implementation HappierSimulatorPressTests
- (void)testPress {
    self.continueAfterFailure = NO;
    NSString *path = NSProcessInfo.processInfo.environment[@"HAPPIER_SIMULATOR_PRESS_REQUEST"];
    NSDictionary *request = [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:path] options:0 error:nil];
    if (!request) { XCTFail(@"Accessibility press request is missing"); return; }
    NSMutableDictionary *response = [@{ @"ok": @NO } mutableCopy];
    @try {
        XCUIApplication *app = [[XCUIApplication alloc] initWithBundleIdentifier:request[@"appBundleId"]];
        if (app.state != XCUIApplicationStateRunningForeground) {
            response[@"errorCode"] = @"simulator_accessibility_foreground_changed";
        } else {
            XCUIElementQuery *matches = [[app descendantsMatchingType:XCUIElementTypeAny] matchingIdentifier:request[@"identifier"]];
            NSUInteger count = matches.count;
            if (count == 0) response[@"errorCode"] = @"simulator_accessibility_element_not_found";
            else if (count != 1) response[@"errorCode"] = @"simulator_accessibility_element_ambiguous";
            else {
                XCUIElement *element = matches.element;
                if (!element.enabled || !element.hittable) response[@"errorCode"] = @"simulator_accessibility_element_not_hittable";
                else { [element tap]; response[@"ok"] = @YES; }
            }
        }
    } @catch (NSException *exception) {
        response[@"errorCode"] = @"simulator_accessibility_press_failed";
        response[@"cause"] = exception.reason ?: @"XCTest press failed";
    }
    NSData *data = [NSJSONSerialization dataWithJSONObject:response options:0 error:nil];
    XCTAssertTrue([data writeToFile:request[@"resultPath"] atomically:YES]);
}
@end
