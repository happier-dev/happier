import type { EnvironmentSecretBindingV1, MachineSecretGrantSubjectV1, MachineSecretGrantV1 } from '@happier-dev/deployment-protocol';

type GrantContent = Readonly<{ kind: 'secret'; value: string }>
    | Readonly<{ kind: 'environmentValues'; definition: Exclude<EnvironmentSecretBindingV1['source'], { kind: 'secret' }> }>
    | Readonly<{ kind: 'connectorToken'; token: string }>;

/** The installation envelope has one wire author; hosts supply their crypto adapter. */
export function sealMachineSecretGrantEnvelopeV1(input: Readonly<{
    subject: MachineSecretGrantSubjectV1;
    content: GrantContent;
    seal(plaintext: Uint8Array): string;
}>): MachineSecretGrantV1 {
    const plaintext = new TextEncoder().encode(JSON.stringify({ subject: input.subject, content: input.content }));
    try { return { ...input.subject, sealedContent: input.seal(plaintext) }; }
    finally { plaintext.fill(0); }
}
