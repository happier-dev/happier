#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface HappierSherpaSileroVadDetector : NSObject

- (nullable instancetype)initWithModelPath:(NSString *)modelPath
                               sampleRate:(int32_t)sampleRate
                             minSpeechSec:(float)minSpeechSec
                            minSilenceSec:(float)minSilenceSec
                                    error:(NSError * _Nullable * _Nullable)error;

/// Returns true when a speech segment is available (i.e. "speech ended").
- (BOOL)acceptWaveform:(const float *)samples count:(int32_t)count;

- (void)close;

@end

NS_ASSUME_NONNULL_END
