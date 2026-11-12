import { Platform } from 'react-native';
import { serializeContentValue, parseContentValue, type ContentValueResult } from '@happier-dev/protocol/crypto/contentByteCodec';
import { encodeContentValueWeb, decodeLegacyContentValueWeb } from '@happier-dev/protocol/crypto/contentByteCodecWeb';
import { openSessionDataKeyBundle, sealSessionMessageDataKeyBundle } from '@happier-dev/protocol/crypto/sessionDataKeyBundleWebCrypto';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { SESSION_DATA_KEY_NONCE_BYTES, type SessionDataKeyOpenResult } from '@happier-dev/protocol/crypto/sessionDataKeyBundleV0';
import { encodeNativeContentValue, decodeNativeContentValue, sealNativeSessionMessageContent, openNativeSessionMessageContent } from './nativeCryptoWorker/nativeCryptoWorker.native';

export async function encodeSessionMessageContent(value: unknown): Promise<Uint8Array> {
    return Platform.OS === 'web' ? await encodeContentValueWeb(value) : await encodeNativeContentValue(serializeContentValue(value));
}

export async function decodeSessionMessageContent(bytes: Uint8Array): Promise<ContentValueResult> {
    if (Platform.OS === 'web') return await decodeLegacyContentValueWeb(bytes);
    if (bytes[0] !== 0 && bytes[0] !== 1) return parseContentValue(bytes);
    const json = await decodeNativeContentValue(bytes);
    return json === null ? { status: 'invalid_payload' } : parseContentValue(new TextEncoder().encode(json));
}

export async function sealSessionMessageContent(value: unknown, key: Uint8Array): Promise<Uint8Array> {
    return Platform.OS === 'web'
        ? await sealSessionMessageDataKeyBundle(value, key)
        : await sealNativeSessionMessageContent(serializeContentValue(value), key, getRandomBytes(SESSION_DATA_KEY_NONCE_BYTES));
}

export async function openSessionMessageContent(bundle: Uint8Array, key: Uint8Array): Promise<SessionDataKeyOpenResult> {
    if (Platform.OS === 'web') return await openSessionDataKeyBundle(bundle, key);
    const opened = await openNativeSessionMessageContent(bundle, key);
    return opened.status === 'authenticated' ? parseContentValue(new TextEncoder().encode(opened.serializedJson)) : opened;
}
