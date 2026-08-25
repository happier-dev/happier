#import <Foundation/Foundation.h>
#include <stdint.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * Offline TTS, addressed by the assets directory the model-pack installer
 * promotes bytes into.
 *
 * Engines are cached per assets directory inside the shared C++ cache that the
 * Android JNI layer also uses, so both platforms have one lifetime model and one
 * invalidation seam: a synthesis owns its engine for the whole call, while a
 * concurrent pack invalidation retires the cache entry and marks the running
 * jobs cancelled. Ownership lives here rather than in a Swift-side dictionary
 * for the same reason streaming ASR keeps it in `HappierSherpaOnlineAsrEngine`:
 * a Swift dictionary cannot hand a synthesis a lease that outlives the eviction.
 */
@interface HappierSherpaOfflineTtsEngine : NSObject

/**
 * Admit one initialize request before it yields to the TTS worker. Its immutable
 * id may be cancelled without retiring the cached engine for this pack.
 */
+ (BOOL)admitInitializationForAssetsDir:(NSString *)assetsDir
                            admissionId:(NSString *)admissionId
    NS_SWIFT_NAME(admitInitialization(assetsDir:admissionId:));

/** Refuse one queued initialize request without mutating this pack's runtime. */
+ (void)cancelInitializationForAssetsDir:(NSString *)assetsDir
                              admissionId:(NSString *)admissionId
    NS_SWIFT_NAME(cancelInitialization(assetsDir:admissionId:));

/** Build (or reuse) the engine for `assetsDir` so later calls are warm. */
+ (BOOL)prepareAssetsDir:(NSString *)assetsDir
                   error:(NSError * _Nullable * _Nullable)error
    NS_SWIFT_NAME(prepare(assetsDir:));

/**
 * Continue a worker request admitted by `admitInitializationForAssetsDir:`. A
 * cancellation that overtook that admission is refused before it can load or
 * publish an engine, without retiring an active same-pack engine.
 */
+ (BOOL)prepareAssetsDir:(NSString *)assetsDir
             admissionId:(NSString *)admissionId
                   error:(NSError * _Nullable * _Nullable)error
    NS_SWIFT_NAME(prepare(assetsDir:admissionId:));

/** Speakers the pack at `assetsDir` exposes; 0 when its engine cannot be built. */
+ (int32_t)numSpeakersForAssetsDir:(NSString *)assetsDir
    NS_SWIFT_NAME(numSpeakers(assetsDir:));

/**
 * Synthesize `text` to `wavPath` using the engine cached for `assetsDir`,
 * reporting the engine's sample rate through `outSampleRate`. The engine is
 * leased for the whole call, so a pack invalidation racing it retires the cache
 * entry and cancels the job without freeing the engine underneath the decode.
 */
+ (BOOL)synthesizeToWavFileAtPath:(NSString *)wavPath
                        assetsDir:(NSString *)assetsDir
                             text:(NSString *)text
                              sid:(int32_t)sid
                            speed:(float)speed
                            jobId:(NSString *)jobId
                       sampleRate:(int32_t *)outSampleRate
                            error:(NSError * _Nullable * _Nullable)error
    NS_SWIFT_NAME(synthesizeToWavFile(atPath:assetsDir:text:sid:speed:jobId:sampleRate:));

/** Mark `jobId` cancelled on every cached engine. Safe from any thread. */
+ (void)cancelJob:(NSString *)jobId NS_SWIFT_NAME(cancelJob(_:));

/**
 * Retire the engine cached for `assetsDir` and cancel the synthesis still
 * running on it, so a model pack whose bytes are being replaced or removed stops
 * being served from memory. Returns the number of engines retired (0 or 1).
 */
+ (NSUInteger)releaseAssetsDir:(NSString *)assetsDir NS_SWIFT_NAME(releaseAssetsDir(_:));

/**
 * Retire every cached engine. The cache outlives the Expo module object, so
 * teardown releases its native handles here exactly once instead of leaving them
 * held for the life of the process. Returns the number of engines retired.
 */
+ (NSUInteger)releaseAll NS_SWIFT_NAME(releaseAll());

@end

NS_ASSUME_NONNULL_END
