// @ts-check
import { execFileSync } from 'node:child_process';

// Android App Bundles contain AAPT2 protobuf XmlNode, not APK binary XML.
// Schema: AOSP tools/aapt2/Resources.proto (XmlNode, XmlElement, XmlAttribute, Item, Primitive).
function fields(buffer) {
  let offset = 0;
  const result = [];
  const varint = () => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (offset >= buffer.length) throw new Error('Truncated protobuf varint');
      const byte = buffer[offset++];
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return value;
    }
    throw new Error('Invalid protobuf varint');
  };
  while (offset < buffer.length) {
    const tag = Number(varint());
    const wire = tag & 7;
    if (tag < 8) throw new Error('Invalid protobuf field');
    let value;
    if (wire === 0) value = varint();
    else if (wire === 2) {
      const length = Number(varint());
      if (!Number.isSafeInteger(length) || length > buffer.length - offset) throw new Error('Truncated protobuf field');
      value = buffer.subarray(offset, offset + length);
      offset += length;
    } else if (wire === 1 || wire === 5) {
      const length = wire === 1 ? 8 : 4;
      if (length > buffer.length - offset) throw new Error('Truncated protobuf field');
      value = buffer.subarray(offset, offset + length);
      offset += length;
    } else throw new Error('Unsupported protobuf wire type');
    result.push({ number: tag >>> 3, wire, value });
  }
  return result;
}

// Shared Android bundle protobuf decoding for manifest identity and packaging.
export { fields as readAndroidBundleProtobufFields };

function message(entries, number) {
  const entry = entries.find((entry) => entry.number === number && entry.wire === 2);
  if (!entry || !Buffer.isBuffer(entry.value)) throw new Error('Missing protobuf message');
  return fields(entry.value);
}

function text(entries, number) {
  const entry = entries.find((entry) => entry.number === number && entry.wire === 2);
  return entry && Buffer.isBuffer(entry.value) ? entry.value.toString('utf8') : '';
}

/** @param {{aabPath: string, env?: NodeJS.ProcessEnv}} options */
export function readAndroidAabMetadata(options) {
  try {
    const buffer = execFileSync('unzip', ['-p', options.aabPath, 'base/manifest/AndroidManifest.xml'], {
      env: options.env ?? process.env, encoding: null, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const element = message(fields(buffer), 1);
    if (text(element, 3) !== 'manifest') throw new Error('Expected manifest root');
    const attributes = element.filter((entry) => entry.number === 4 && Buffer.isBuffer(entry.value)).map((entry) => fields(entry.value));
    const find = (name, namespace) => {
      const matches = attributes.filter((entry) => text(entry, 2) === name && text(entry, 1) === namespace);
      if (matches.length !== 1) throw new Error('Missing or duplicate manifest identity');
      return matches[0];
    };
    const android = 'http://schemas.android.com/apk/res/android';
    const versionAttribute = find('versionCode', android);
    let versionCode = text(versionAttribute, 3);
    if (versionAttribute.some((entry) => entry.number === 6)) {
      const primitive = message(message(versionAttribute, 6), 7);
      const integer = primitive.find((entry) => (entry.number === 6 || entry.number === 7) && entry.wire === 0);
      if (!integer) throw new Error('Missing compiled versionCode');
      versionCode = String(integer.value);
    }
    const packageName = text(find('package', ''), 3);
    const versionNameAttribute = find('versionName', android);
    let appVersion = text(versionNameAttribute, 3);
    if (versionNameAttribute.some((entry) => entry.number === 6)) appVersion = text(message(message(versionNameAttribute, 6), 2), 1);
    if (!packageName || !appVersion || !/^[1-9]\d*$/u.test(versionCode)) throw new Error('Missing identity');
    return { packageName, versionCode, appVersion };
  } catch {
    throw new Error('Unable to read exact Android package/version identity from the AAB manifest (requires unzip).');
  }
}
