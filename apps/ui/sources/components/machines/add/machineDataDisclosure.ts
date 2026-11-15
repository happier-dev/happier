import { t } from '@/text';

export type MachineDataDisclosure = Readonly<{
  description: string;
  rows: readonly Readonly<{
    id: 'daemonSends' | 'devicesRead' | 'serverReads';
    title: string;
    detail: string;
  }>[];
}>;

/**
 * Add a machine → What leaves this Machine (pfc-redesign dConnect #2), following the Account's persisted
 * `encryptionMode` (the one authority for end-to-end encryption, docs/encryption.md): what the daemon sends, who can
 * read it on an end-to-end encrypted Account (the person's devices and whoever they share this Machine or a Session
 * with), and what the Happier server can read. Unknown mode claims nothing. Wording reviewed by SEC-REVIEW-1115.
 */
export function machineDataDisclosure(
  mode: 'e2ee' | 'plain' | null,
): MachineDataDisclosure | null {
  if (mode === null) return null;
  const s = 'machineDataDisclosure' as const;
  const daemonSends = {
    id: 'daemonSends' as const,
    title: t(`${s}.daemonSends`),
    detail: t(`${s}.daemonSendsDetail`),
  };
  if (mode === 'plain') {
    return {
      description: t(`${s}.plainDescription`),
      rows: [
        daemonSends,
        {
          id: 'serverReads',
          title: t(`${s}.serverReads`),
          detail: t(`${s}.serverReadsPlain`),
        },
      ],
    };
  }
  return {
    description: t(`${s}.e2eeDescription`),
    rows: [
      daemonSends,
      {
        id: 'devicesRead',
        title: t(`${s}.devicesRead`),
        detail: t(`${s}.devicesReadDetail`),
      },
      {
        id: 'serverReads',
        title: t(`${s}.serverReads`),
        detail: t(`${s}.serverReadsE2ee`),
      },
    ],
  };
}
