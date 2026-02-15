#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface HappierSherpaOnlineAsrStream : NSObject

- (NSDictionary *)pushPcm16Data:(NSData *)pcm16le
                     sampleRate:(int32_t)sampleRate
                       channels:(int32_t)channels
                          error:(NSError * _Nullable * _Nullable)error;

- (NSString *)finishWithError:(NSError * _Nullable * _Nullable)error;

- (void)cancel;

@end

@interface HappierSherpaOnlineAsrEngine : NSObject

- (instancetype)initWithAssetsDir:(NSString *)assetsDir
                       sampleRate:(int32_t)sampleRate
                         language:(NSString * _Nullable)language
                            error:(NSError * _Nullable * _Nullable)error;

- (HappierSherpaOnlineAsrStream * _Nullable)createStreamWithError:(NSError * _Nullable * _Nullable)error;

@end

NS_ASSUME_NONNULL_END

