# @happier-dev/sherpa-native

Expo native module for on-device Kokoro TTS and streaming STT (mobile), backed by the sherpa-onnx C API.

## Runtime version and C API header

Android (`android/build.gradle`) and iOS (`ios/HappierSherpaNative.podspec`) pin the same sherpa-onnx release
(`HAPPIER_SHERPA_ONNX_VERSION`, default `v1.12.25`). The Android release archive ships only prebuilt `.so` files, so
the JNI layer compiles against `android/src/main/cpp/include/sherpa-onnx/c-api/c-api.h`, a verbatim copy of upstream
`sherpa-onnx/c-api/c-api.h` at that tag. iOS compiles against the header inside the downloaded xcframework.

To bump the version, replace the vendored header with the new tag's upstream file and update its sha256 in
`scripts/sherpa-c-api-header.test.mjs`; `yarn test` fails while the header and the pinned version disagree.

## Threading

Expo runs every module's `AsyncFunction`s on one shared queue. TTS work (`initialize`, `listVoices`,
`synthesizeToWavFile`, `release`) and ASR work (`createStreamingRecognizer`, `pushAudioFrame`, `finishStreaming`) run
on their own serial queues, so `cancel` and microphone frames never wait behind a synthesis.

## Engine lifecycle

Engines are cached per assets dir (a trailing slash is ignored). `release({ assetsDir })` drops the cached TTS and
ASR engines so the next use loads the dir's current files; it waits for an in-flight synthesis, and running ASR
streams keep their engine until they finish. The model-pack installer calls it before updating or removing a pack.

`excludeFromBackup({ path })` marks a directory as excluded from iCloud backup on iOS. It is a no-op on Android,
where the app's Auto Backup rules already include only shared preferences.

`release` and `excludeFromBackup` are optional in the TypeScript type because older native builds lack them.
