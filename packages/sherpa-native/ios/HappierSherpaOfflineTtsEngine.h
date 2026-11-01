#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface HappierSherpaOfflineTtsEngine : NSObject

- (nullable instancetype)initWithAssetsDir:(NSString *)assetsDir error:(NSError **)error;

- (int32_t)sampleRate;
- (int32_t)numSpeakers;

- (BOOL)synthesizeToWavFileAtPath:(NSString *)wavPath
                             text:(NSString *)text
                              sid:(int32_t)sid
                            speed:(float)speed
                            jobId:(NSString *)jobId
                            error:(NSError **)error;

/// Cancels an accepted synthesis, queued or running. Unknown or finished job ids are ignored.
+ (void)cancelJob:(NSString *)jobId;
/// Registers a synthesis when it is accepted, before it waits on the TTS queue, so a cancel is not lost.
+ (void)acceptJob:(NSString *)jobId;
/// Drops an accepted job once it has ended, however it ended.
+ (void)forgetJob:(NSString *)jobId;

@end

NS_ASSUME_NONNULL_END
