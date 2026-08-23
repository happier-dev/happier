#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * Streaming ASR, addressed by job id.
 *
 * Recognizers are cached per assets directory and streams are indexed by job id
 * inside the shared C++ registry that the Android JNI layer also uses, so both
 * platforms have one lifetime model: a push owns its stream and recognizer for
 * the whole decode, while a concurrent cancel or a pack invalidation only marks
 * the job and drops the registry's reference. Ownership therefore lives here
 * rather than in a Swift-side dictionary, the way offline TTS keeps its job
 * registry inside the engine.
 */
@interface HappierSherpaOnlineAsrEngine : NSObject

/** Open a stream for `jobId`, building the recognizer for `assetsDir` on first use. */
+ (BOOL)createStreamForJob:(NSString *)jobId
                 assetsDir:(NSString *)assetsDir
                     error:(NSError * _Nullable * _Nullable)error;

/** Decode one PCM16 frame, returning `{ text, isEndpoint }`. */
+ (NSDictionary *)pushPcm16Data:(NSData *)pcm16le
                         forJob:(NSString *)jobId
                     sampleRate:(int32_t)sampleRate
                       channels:(int32_t)channels
                          error:(NSError * _Nullable * _Nullable)error;

/**
 * Drain the tail of `jobId` and release its stream, reporting which outcome
 * actually happened: `{ status: "finalized", text }`, `{ status: "cancelled" }`,
 * or `{ status: "missing" }` when nothing live is registered under the id.
 *
 * Only a finalized outcome carries text. A finalized empty utterance -- silence
 * -- is a successful empty transcript; a cancelled or absent job is not, and
 * collapsing the three into one empty string is what let the JS controller
 * promote its last interim partial to a final transcript.
 */
+ (NSDictionary *)finishJob:(NSString *)jobId;

/** Mark `jobId` cancelled and release the registry's reference to it. */
+ (void)cancelJob:(NSString *)jobId;

/**
 * Drop the recognizer cached for `assetsDir` and cancel the jobs decoding
 * against it, so a model pack whose bytes are being replaced or removed stops
 * being served from memory. Returns the number of jobs cancelled.
 */
+ (NSUInteger)releaseAssetsDir:(NSString *)assetsDir;

/**
 * Drop every cached recognizer and cancel every job. The registry outlives the
 * Expo module object, so teardown releases its native handles here instead of
 * leaving them held for the life of the process. Returns the jobs cancelled.
 */
+ (NSUInteger)releaseAll;

@end

NS_ASSUME_NONNULL_END
