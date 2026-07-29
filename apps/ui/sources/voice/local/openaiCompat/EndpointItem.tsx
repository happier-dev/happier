import * as React from 'react';

import { Item } from '@/components/ui/lists/Item';
import { Modal } from '@/modal';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useVoiceExecutionMachinePresentation } from '@/voice/credentials/useExecutionMachinePresentation';

import { promptOpenAiCompatEndpointChange, type OpenAiCompatEndpointPatch } from './endpointAction';

export const OpenAiCompatEndpointItem = React.memo(function OpenAiCompatEndpointItem(props: Readonly<{
  title: string;
  promptTitle: string;
  promptDescription: string;
  baseUrl: string | null;
  insecureLocalOriginConsent: string | null;
  insecureLocalConsentMachineId: string | null;
  onChange: (patch: OpenAiCompatEndpointPatch) => void;
}>) {
  const { machineId, machineLabel } = useVoiceExecutionMachinePresentation();
  return (
    <Item
      title={props.title}
      subtitle={machineLabel
        ? t('settingsVoice.local.openAiCompatEndpoint.executionMachine', { machine: machineLabel })
        : t('settingsVoice.local.voiceCredential.machineUnavailable')}
      detail={props.baseUrl || t('settingsVoice.local.notSet')}
      onPress={() => {
        fireAndForget((async () => {
          const patch = await promptOpenAiCompatEndpointChange({
            currentBaseUrl: props.baseUrl,
            currentConsent: props.insecureLocalOriginConsent,
            currentConsentMachineId: props.insecureLocalConsentMachineId,
            machineId,
            machineLabel,
            promptBaseUrl: async () => await Modal.prompt(
              props.promptTitle,
              props.promptDescription,
              { placeholder: props.baseUrl ?? '' },
            ),
            confirmInsecureOrigin: async ({ origin, machineLabel: selectedMachine }) => await Modal.confirm(
              t('settingsVoice.local.openAiCompatEndpoint.insecureTitle'),
              t('settingsVoice.local.openAiCompatEndpoint.insecureBody', {
                origin,
                machine: selectedMachine,
              }),
              { confirmText: t('settingsVoice.local.openAiCompatEndpoint.allowAction') },
            ),
            showInvalidEndpoint: async (reason) => await Modal.alertAsync(
              t('common.error'),
              reason === 'machine_unavailable'
                ? t('settingsVoice.local.voiceCredential.machineUnavailableBody')
                : t('settingsVoice.local.openAiCompatEndpoint.invalidBody'),
            ),
          });
          if (patch) props.onChange(patch);
        })(), { tag: 'OpenAiCompatEndpointItem.prompt' });
      }}
    />
  );
});
