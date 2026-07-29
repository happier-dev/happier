#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface HappierSherpaSileroVadDetector : NSObject

- (nullable instancetype)initWithModelPath:(NSString *)modelPath
                               sampleRate:(int32_t)sampleRate
                             minSpeechSec:(float)minSpeechSec
                            minSilenceSec:(float)minSilenceSec
                                    error:(NSError * _Nullable * _Nullable)error;

/// Returns true when a completed speech segment is available. `speechDetected`
/// reports the current candidate state before any completed segment is reset.
- (BOOL)acceptWaveform:(const float *)samples
                 count:(int32_t)count
        speechDetected:(BOOL *)speechDetected;

- (void)close;

@end

NS_ASSUME_NONNULL_END
