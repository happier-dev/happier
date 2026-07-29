import { randomBytes } from 'node:crypto';
import {
  chmod,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecureContext } from 'node:tls';

import {
  AuthorityKeyIdentifierExtension,
  BasicConstraintsExtension,
  ExtendedKeyUsage,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  PemConverter,
  SubjectAlternativeNameExtension,
  SubjectKeyIdentifierExtension,
  X509CertificateGenerator,
  cryptoProvider,
} from '@peculiar/x509';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const CA_NAME = 'CN=Happier Ephemeral TLS Test CA';
const LEAF_NAME = 'CN=localhost';
const RSA_KEY_ALGORITHM = Object.freeze({
  name: 'RSASSA-PKCS1-v1_5',
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: 'SHA-256',
});

function certificateSerialNumber() {
  const bytes = randomBytes(16);
  bytes[0] &= 0x7f;
  if (bytes.every((value) => value === 0)) bytes[bytes.length - 1] = 1;
  return bytes.toString('hex');
}

async function generateKeyPair(crypto) {
  const keys = await crypto.subtle.generateKey(
    RSA_KEY_ALGORITHM,
    true,
    ['sign', 'verify'],
  );
  if (!('privateKey' in keys)) {
    throw new Error('ephemeral_tls_fixture_key_pair_missing');
  }
  return keys;
}

function normalizeAdditionalDnsNames(dnsNames) {
  const normalized = dnsNames.map((value) => value.trim().toLowerCase());
  if (normalized.some((value) => (
    value.length === 0
    || value.length > 253
    || value.includes('\0')
  ))) {
    throw new Error('ephemeral_tls_fixture_dns_name_invalid');
  }
  return [...new Set(normalized)].sort();
}

export async function createEphemeralTlsServerFixture(input = {}) {
  const directoryPath = await mkdtemp(
    join(tmpdir(), 'happier-ephemeral-tls-'),
  );
  const caCertificatePath = join(directoryPath, 'ca-certificate.pem');
  const leafCertificatePath = join(directoryPath, 'server-certificate.pem');
  const privateKeyPath = join(directoryPath, 'server-private-key.pem');
  let privateKeyPem = null;

  try {
    await chmod(directoryPath, PRIVATE_DIRECTORY_MODE);
    const crypto = cryptoProvider.get();
    const dnsNames = normalizeAdditionalDnsNames(
      input.additionalDnsNames ?? [],
    );
    const [caKeys, leafKeys] = await Promise.all([
      generateKeyPair(crypto),
      generateKeyPair(crypto),
    ]);
    const now = Date.now();
    const notBefore = new Date(now - 60_000);
    const notAfter = new Date(now + 24 * 60 * 60 * 1_000);
    const caCertificate = await X509CertificateGenerator.createSelfSigned({
      serialNumber: certificateSerialNumber(),
      name: CA_NAME,
      notBefore,
      notAfter,
      signingAlgorithm: RSA_KEY_ALGORITHM,
      keys: caKeys,
      extensions: [
        new BasicConstraintsExtension(true, 0, true),
        new KeyUsagesExtension(
          KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign,
          true,
        ),
        await SubjectKeyIdentifierExtension.create(
          caKeys.publicKey,
          false,
          crypto,
        ),
      ],
    }, crypto);
    const leafCertificate = await X509CertificateGenerator.create({
      serialNumber: certificateSerialNumber(),
      subject: LEAF_NAME,
      issuer: CA_NAME,
      notBefore,
      notAfter,
      signingAlgorithm: RSA_KEY_ALGORITHM,
      publicKey: leafKeys.publicKey,
      signingKey: caKeys.privateKey,
      extensions: [
        new BasicConstraintsExtension(false, undefined, true),
        new KeyUsagesExtension(
          KeyUsageFlags.digitalSignature | KeyUsageFlags.keyEncipherment,
          true,
        ),
        new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth]),
        new SubjectAlternativeNameExtension([
          { type: 'dns', value: 'localhost' },
          ...dnsNames
            .filter((value) => value !== 'localhost')
            .map((value) => ({ type: 'dns', value })),
          { type: 'ip', value: '127.0.0.1' },
        ]),
        await SubjectKeyIdentifierExtension.create(
          leafKeys.publicKey,
          false,
          crypto,
        ),
        await AuthorityKeyIdentifierExtension.create(
          caKeys.publicKey,
          false,
          crypto,
        ),
      ],
    }, crypto);
    const exportedPrivateKey = await crypto.subtle.exportKey(
      'pkcs8',
      leafKeys.privateKey,
    );
    privateKeyPem = Buffer.from(PemConverter.encode(
      exportedPrivateKey,
      PemConverter.PrivateKeyTag,
    ));
    const caCertificatePem = Buffer.from(caCertificate.toString('pem'));
    const leafCertificatePem = Buffer.from(leafCertificate.toString('pem'));
    await Promise.all([
      writeFile(caCertificatePath, caCertificatePem, {
        flag: 'wx',
        mode: PRIVATE_FILE_MODE,
      }),
      writeFile(leafCertificatePath, leafCertificatePem, {
        flag: 'wx',
        mode: PRIVATE_FILE_MODE,
      }),
      writeFile(privateKeyPath, privateKeyPem, {
        flag: 'wx',
        mode: PRIVATE_FILE_MODE,
      }),
    ]);
    await Promise.all([
      chmod(caCertificatePath, PRIVATE_FILE_MODE),
      chmod(leafCertificatePath, PRIVATE_FILE_MODE),
      chmod(privateKeyPath, PRIVATE_FILE_MODE),
    ]);
    const secureContext = createSecureContext({
      cert: Buffer.concat([
        leafCertificatePem,
        Buffer.from('\n'),
        caCertificatePem,
      ]),
      key: privateKeyPem,
    });
    let cleanupPromise = null;
    return Object.freeze({
      directoryPath,
      caCertificatePath,
      leafCertificatePath,
      privateKeyPath,
      secureContext,
      cleanup: async () => {
        cleanupPromise ??= rm(
          directoryPath,
          { recursive: true, force: true },
        ).catch((error) => {
          cleanupPromise = null;
          throw error;
        });
        await cleanupPromise;
      },
    });
  } catch (error) {
    await rm(directoryPath, { recursive: true, force: true })
      .catch(() => undefined);
    throw error;
  } finally {
    privateKeyPem?.fill(0);
  }
}
