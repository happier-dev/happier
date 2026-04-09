import type { BackgroundServiceSetupGuidance } from './buildBackgroundServiceSetupGuidance.js';

export type BackgroundServiceSetupGuidanceCancellationReason =
  | 'declined_release_channel_switch'
  | 'declined_service_replacement';

export type BackgroundServiceSetupGuidanceFlowResult = Readonly<{
  cancelled: boolean;
  cancellationReason: BackgroundServiceSetupGuidanceCancellationReason | null;
  switchedDefaultReleaseChannel: boolean;
  replacedExistingServices: boolean;
}>;

export async function applyBackgroundServiceSetupGuidance(params: Readonly<{
  guidance: BackgroundServiceSetupGuidance;
  promptSwitchDefaultReleaseChannel: () => Promise<boolean>;
  promptReplaceExistingServices: () => Promise<boolean>;
  switchDefaultReleaseChannel: () => Promise<void>;
  replaceExistingServices: () => Promise<void>;
}>): Promise<BackgroundServiceSetupGuidanceFlowResult> {
  let switchedDefaultReleaseChannel = false;
  let replacedExistingServices = false;

  if (params.guidance.shouldOfferDefaultReleaseChannelSwitch) {
    const shouldSwitch = await params.promptSwitchDefaultReleaseChannel();
    if (!shouldSwitch) {
      return {
        cancelled: true,
        cancellationReason: 'declined_release_channel_switch',
        switchedDefaultReleaseChannel: false,
        replacedExistingServices: false,
      };
    }
    await params.switchDefaultReleaseChannel();
    switchedDefaultReleaseChannel = true;
  }

  if (params.guidance.shouldPromptForServiceReplacement) {
    const shouldReplace = await params.promptReplaceExistingServices();
    if (!shouldReplace) {
      return {
        cancelled: true,
        cancellationReason: 'declined_service_replacement',
        switchedDefaultReleaseChannel,
        replacedExistingServices: false,
      };
    }
    await params.replaceExistingServices();
    replacedExistingServices = true;
  }

  return {
    cancelled: false,
    cancellationReason: null,
    switchedDefaultReleaseChannel,
    replacedExistingServices,
  };
}
