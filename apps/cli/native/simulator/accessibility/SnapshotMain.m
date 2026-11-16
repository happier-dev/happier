#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#import <sys/sysctl.h>

#import "upstream/SnapshotBridgeRuntime.h"
#import "upstream/ForegroundApplicationGeometry.h"

NSDictionary *failureResponse(NSString *requestId, NSString *kind, NSString *code, NSString *message) {
    return @{ @"ok": @NO, @"error_kind": kind ?: @"reader_unavailable", @"error_code": code ?: @"native_error", @"error": message ?: @"Accessibility reader failed" };
}

static NSString *bundleIdentifier(pid_t pid) {
    int name[] = { CTL_KERN, KERN_PROCARGS2, pid };
    size_t size = 0;
    if (sysctl(name, 3, NULL, &size, NULL, 0) != 0 || size <= sizeof(int)) return nil;
    NSMutableData *buffer = [NSMutableData dataWithLength:size];
    if (sysctl(name, 3, buffer.mutableBytes, &size, NULL, 0) != 0 || size <= sizeof(int)) return nil;
    const char *path = (const char *)buffer.bytes + sizeof(int);
    size_t length = strnlen(path, size - sizeof(int));
    if (length == 0 || length == size - sizeof(int)) return nil;
    NSString *executable = [[NSString alloc] initWithBytes:path length:length encoding:NSUTF8StringEncoding];
    NSRange app = [executable rangeOfString:@".app/" options:NSBackwardsSearch];
    return app.location == NSNotFound ? nil : [NSBundle bundleWithPath:[executable substringToIndex:NSMaxRange(app) - 1]].bundleIdentifier;
}

static NSDictionary *snapshot(BOOL targetOnly) {
    NSString *error = nil;
    BridgeRuntime *runtime = sharedRuntime(&error);
    if (!runtime) return failureResponse(@"", @"unsupported", @"runtime-unavailable", error);
    Class<AgentDeviceForegroundElement> elementClass = (Class<AgentDeviceForegroundElement>)objc_lookUpClass("AXElement");
    if (![elementClass respondsToSelector:@selector(primaryApp)]) return failureResponse(@"", @"unsupported", @"foreground-owner-unverified", @"AXRuntime cannot read the foreground application");
    id<AgentDeviceForegroundElement> app = [elementClass primaryApp];
    if (![app respondsToSelector:@selector(pid)] || app.pid <= 0 || ![app respondsToSelector:@selector(frame)]) return failureResponse(@"", @"unsupported", @"foreground-owner-unverified", @"No foreground accessibility application");
    CGRect frame = app.frame;
    if (!AgentDeviceForegroundFrameIsMeasurable(frame)) return failureResponse(@"", @"unsupported", @"foreground-frame-unavailable", @"Foreground application has no measurable frame");
    NSString *bundleId = bundleIdentifier(app.pid);
    if (!bundleId) return failureResponse(@"", @"unsupported", @"foreground-bundle-unavailable", @"Foreground application bundle could not be resolved");
    if (targetOnly) return @{ @"ok": @YES, @"appBundleId": bundleId };
    NSDictionary *failure = nil;
    // These are the reader's existing native API bounds, rather than a shorter host budget.
    NSDictionary *result = [runtime snapshotForProcess:app.pid maxDepth:kMaximumDepth maxNodes:kMaximumNodes nativeLevelsHint:0 requestId:@"" generation:@"" maxDurationMs:kMaximumDurationMs error:&failure];
    if (!result) return failure ?: failureResponse(@"", @"reader_unavailable", @"empty-response", @"AXRuntime returned no snapshot");
    NSMutableDictionary *response = [result mutableCopy];
    response[@"appBundleId"] = bundleId;
    response[@"viewport"] = @{ @"width": @(frame.size.width), @"height": @(frame.size.height) };
    return response;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSDictionary *response;
        @try { response = snapshot(argc > 1 && strcmp(argv[1], "target") == 0); }
        @catch (NSException *exception) { response = failureResponse(@"", @"reader_unavailable", @"private-api-exception", exception.reason); }
        NSData *data = [NSJSONSerialization dataWithJSONObject:response options:0 error:nil];
        if (!data) return 1;
        fwrite(data.bytes, 1, data.length, stdout);
        return 0;
    }
}
