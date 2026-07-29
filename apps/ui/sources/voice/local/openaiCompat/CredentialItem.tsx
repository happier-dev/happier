import * as React from 'react';

import { VoiceCredentialItem } from '@/voice/credentials/CredentialItem';
import { useVoiceExecutionMachinePresentation } from '@/voice/credentials/useExecutionMachinePresentation';

export const OpenAiCompatCredentialItem = React.memo(function OpenAiCompatCredentialItem(props: Readonly<{
  title: string;
  promptTitle: string;
  promptDescription: string;
  credentialKind: string;
  legacySecretValue: unknown | null;
}>) {
  const machine = useVoiceExecutionMachinePresentation();
  return (
    <VoiceCredentialItem
      title={props.title}
      promptTitle={props.promptTitle}
      promptDescription={props.promptDescription}
      providerId="openai_compat"
      credentialSlotId={props.credentialKind}
      machineId={machine.machineId}
      machineLabel={machine.machineLabel}
      disclosePlainStorage={false}
    />
  );
});
