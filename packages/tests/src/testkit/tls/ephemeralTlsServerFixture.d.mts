import type { SecureContext } from 'node:tls';

export type EphemeralTlsServerFixture = Readonly<{
  directoryPath: string;
  caCertificatePath: string;
  leafCertificatePath: string;
  privateKeyPath: string;
  secureContext: SecureContext;
  cleanup(): Promise<void>;
}>;

export declare function createEphemeralTlsServerFixture(
  input?: Readonly<{ additionalDnsNames?: readonly string[] }>,
): Promise<EphemeralTlsServerFixture>;
