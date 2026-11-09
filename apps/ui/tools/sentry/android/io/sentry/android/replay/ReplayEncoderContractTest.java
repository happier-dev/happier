package io.sentry.android.replay;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;
import android.graphics.Bitmap;
import android.media.MediaCodec;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import io.sentry.SentryOptions;
import io.sentry.protocol.SentryId;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.ConscryptMode;
import org.robolectric.annotation.GraphicsMode;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.shadows.ShadowBitmapFactory;
import org.robolectric.shadows.ShadowMediaCodec;

// Contract from getsentry/sentry-java#5842, tested against the consumed AAR.
// Only MediaCodec, the OS boundary, is replaced; cache and encoder remain real.
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 26, manifest = Config.NONE, shadows = {ReplayEncoderContractTest.Codec.class})
@GraphicsMode(GraphicsMode.Mode.LEGACY)
@ConscryptMode(ConscryptMode.Mode.OFF)
public class ReplayEncoderContractTest {
  @Rule public TemporaryFolder tmp = new TemporaryFolder();

  @Test public void closingReplayReturnsWhileNativeEncoderIsWedged() throws Exception {
    Codec.wedge = new CountDownLatch(1);
    Codec.entered = new CountDownLatch(1);
    Codec.released = false;
    ShadowBitmapFactory.setAllowInvalidImageData(true);
    SentryOptions options = new SentryOptions();
    File cacheDir = tmp.newFolder();
    options.setCacheDirPath(cacheDir.getAbsolutePath());
    SentryId replayId = new SentryId();
    ReplayCache cache = new ReplayCache(options, replayId);
    File frame = tmp.newFile("frame.jpg");
    Bitmap bitmap = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
    try (FileOutputStream output = new FileOutputStream(frame)) {
      bitmap.compress(Bitmap.CompressFormat.JPEG, 80, output);
    }
    cache.addFrame(frame, 1L, null);
    AtomicReference<Throwable> error = new AtomicReference<>();
    Thread encoder = new Thread(() -> {
      try { cache.createVideoOf(1000L, 0L, 0, 100, 200, 1, 20000, new File(cacheDir, "0.mp4")); }
      catch (Throwable t) { error.set(t); }
    }, "test-native-encoder");
    encoder.setDaemon(true);
    CountDownLatch closed = new CountDownLatch(1);
    Thread closer = new Thread(() -> {
      try { cache.close(); }
      catch (Throwable t) { error.set(t); }
      finally { closed.countDown(); }
    }, "test-replay-close");
    closer.setDaemon(true);
    encoder.start();
    try {
      if (!Codec.entered.await(30, TimeUnit.SECONDS)) {
        if (error.get() != null) throw new AssertionError("encoder setup failed before MediaCodec", error.get());
        fail("codec must actually enter the native boundary");
      }
      assertNull("encoder setup must succeed", error.get());
      closer.start();
      assertTrue("ReplayCache.close must return while MediaCodec remains wedged",
          closed.await(30, TimeUnit.SECONDS));
      assertNull("closing must succeed", error.get());
      assertFalse("wedged codec must not be released concurrently", Codec.released);
      cache.persistSegmentValues$sentry_android_replay_release(ReplayCache.SEGMENT_KEY_ID, "0");
      assertFalse("closed cache must not persist segment metadata",
          new File(new File(cacheDir, "replay_" + replayId), ReplayCache.ONGOING_SEGMENT).exists());
    } finally {
      Codec.wedge.countDown();
      encoder.join(10000L);
      if (closer.getState() != Thread.State.NEW) closer.join(10000L);
    }
    assertFalse("encoder must finish after the native boundary resumes", encoder.isAlive());
    assertFalse("close worker must finish", closer.isAlive());
    assertNull("encoder must recover after the native boundary resumes", error.get());
  }

  @Implements(MediaCodec.class)
  public static class Codec extends ShadowMediaCodec {
    static CountDownLatch wedge;
    static CountDownLatch entered;
    static volatile boolean released;
    private final AtomicBoolean encoded = new AtomicBoolean();

    @Implementation protected void release() { released = true; }
    @Implementation protected void start() { super.native_start(); }
    @Implementation protected void signalEndOfInputStream() {
      encodeFrame(5, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
    }
    @Implementation protected ByteBuffer[] getOutputBuffers() { return super.getBuffers(false); }
    @Implementation protected int dequeueOutputBuffer(MediaCodec.BufferInfo info, long timeoutUs)
        throws InterruptedException {
      entered.countDown();
      wedge.await();
      int status = super.native_dequeueOutputBuffer(info, timeoutUs);
      super.validateOutputByteBuffer(getOutputBuffers(), status, info);
      if (status == MediaCodec.INFO_TRY_AGAIN_LATER && !encoded.getAndSet(true)) {
        for (int index = 0; index < 5; index++) encodeFrame(index, 0);
      }
      return status;
    }
    private void encodeFrame(int index, int flags) {
      super.native_dequeueInputBuffer(0);
      super.native_queueInputBuffer(index, index * 10, 10, index * 1000000L, flags);
    }
  }
}
