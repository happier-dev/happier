import { Modal } from '@/modal';

export type VoiceSessionSpawnPickerResult = Readonly<{ machineId: string; directory: string }>;

export async function openVoiceSessionSpawnPicker(): Promise<VoiceSessionSpawnPickerResult | null> {
  const { VoiceSessionSpawnPickerModal } = await import('./VoiceSessionSpawnPickerModal');
  return await new Promise<VoiceSessionSpawnPickerResult | null>((resolve) => {
    Modal.show({
      component: VoiceSessionSpawnPickerModal,
      props: {
        onResolve: (value: VoiceSessionSpawnPickerResult | null) => resolve(value),
        onRequestClose: () => resolve(null),
      },
      closeOnBackdrop: true,
    });
  });
}
