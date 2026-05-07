#include <jni.h>
#include <sodium.h>

#include <algorithm>
#include <cstdint>
#include <vector>

namespace {
constexpr int kEnvelopeVersion = 0;
constexpr int kEnvelopeVersionBytes = 1;
constexpr int kPublicKeyBytes = crypto_box_PUBLICKEYBYTES;
constexpr int kSecretKeyBytes = crypto_box_SECRETKEYBYTES;
constexpr int kNonceBytes = crypto_box_NONCEBYTES;
constexpr int kMacBytes = crypto_box_MACBYTES;
constexpr int kSha512Bytes = crypto_hash_sha512_BYTES;
constexpr int kSecretboxKeyBytes = crypto_secretbox_KEYBYTES;
constexpr int kSecretboxNonceBytes = crypto_secretbox_NONCEBYTES;
constexpr int kSecretboxMacBytes = crypto_secretbox_MACBYTES;

std::vector<unsigned char> toVector(JNIEnv *env, jbyteArray value) {
  const jsize size = env->GetArrayLength(value);
  std::vector<unsigned char> out(static_cast<size_t>(size));
  if (size > 0) {
    env->GetByteArrayRegion(value, 0, size, reinterpret_cast<jbyte *>(out.data()));
  }
  return out;
}

jbyteArray toJByteArray(JNIEnv *env, const std::vector<unsigned char> &value) {
  auto out = env->NewByteArray(static_cast<jsize>(value.size()));
  if (out != nullptr && !value.empty()) {
    env->SetByteArrayRegion(out, 0, static_cast<jsize>(value.size()), reinterpret_cast<const jbyte *>(value.data()));
  }
  return out;
}

bool openBoxBundle(
    const unsigned char *ephemeralPublicKey,
    const unsigned char *nonce,
    const unsigned char *boxed,
    size_t boxedLength,
    const unsigned char *secretKey,
    std::vector<unsigned char> &out) {
  if (boxedLength < kMacBytes) {
    return false;
  }
  out.assign(boxedLength - kMacBytes, 0);
  return crypto_box_open_easy(out.data(), boxed, static_cast<unsigned long long>(boxedLength), nonce, ephemeralPublicKey, secretKey) == 0;
}
} // namespace

extern "C" JNIEXPORT jbyteArray JNICALL
Java_dev_happier_cryptoworker_HappierCryptoWorkerNative_openDataKeyEnvelopeV1(
    JNIEnv *env,
    jclass,
    jbyteArray envelopeValue,
    jbyteArray recipientSecretKeyOrSeedValue) {
  if (envelopeValue == nullptr || recipientSecretKeyOrSeedValue == nullptr) {
    return nullptr;
  }
  if (sodium_init() < 0) {
    return nullptr;
  }

  const auto envelope = toVector(env, envelopeValue);
  const auto recipientSecretKeyOrSeed = toVector(env, recipientSecretKeyOrSeedValue);
  if (
      recipientSecretKeyOrSeed.size() != kSecretKeyBytes ||
      envelope.size() < static_cast<size_t>(kEnvelopeVersionBytes + kPublicKeyBytes + kNonceBytes + kMacBytes) ||
      envelope[0] != kEnvelopeVersion) {
    return nullptr;
  }

  const unsigned char *bundle = envelope.data() + kEnvelopeVersionBytes;
  const unsigned char *ephemeralPublicKey = bundle;
  const unsigned char *nonce = bundle + kPublicKeyBytes;
  const unsigned char *boxed = bundle + kPublicKeyBytes + kNonceBytes;
  const size_t boxedLength = envelope.size() - kEnvelopeVersionBytes - kPublicKeyBytes - kNonceBytes;

  std::vector<unsigned char> opened;
  if (openBoxBundle(ephemeralPublicKey, nonce, boxed, boxedLength, recipientSecretKeyOrSeed.data(), opened)) {
    return toJByteArray(env, opened);
  }

  unsigned char hash[kSha512Bytes] = {};
  crypto_hash_sha512(hash, recipientSecretKeyOrSeed.data(), recipientSecretKeyOrSeed.size());
  if (openBoxBundle(ephemeralPublicKey, nonce, boxed, boxedLength, hash, opened)) {
    sodium_memzero(hash, sizeof hash);
    return toJByteArray(env, opened);
  }

  sodium_memzero(hash, sizeof hash);
  return nullptr;
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_dev_happier_cryptoworker_HappierCryptoWorkerNative_openSecretboxJson(
    JNIEnv *env,
    jclass,
    jbyteArray ciphertextValue,
    jbyteArray keyValue) {
  if (ciphertextValue == nullptr || keyValue == nullptr) {
    return nullptr;
  }
  if (sodium_init() < 0) {
    return nullptr;
  }

  const auto ciphertext = toVector(env, ciphertextValue);
  const auto key = toVector(env, keyValue);
  if (
      key.size() != kSecretboxKeyBytes ||
      ciphertext.size() < static_cast<size_t>(kSecretboxNonceBytes + kSecretboxMacBytes)) {
    return nullptr;
  }

  const unsigned char *nonce = ciphertext.data();
  const unsigned char *boxed = ciphertext.data() + kSecretboxNonceBytes;
  const size_t boxedLength = ciphertext.size() - kSecretboxNonceBytes;
  std::vector<unsigned char> opened(boxedLength - kSecretboxMacBytes, 0);
  if (crypto_secretbox_open_easy(
          opened.data(),
          boxed,
          static_cast<unsigned long long>(boxedLength),
          nonce,
          key.data()) != 0) {
    return nullptr;
  }

  return toJByteArray(env, opened);
}
