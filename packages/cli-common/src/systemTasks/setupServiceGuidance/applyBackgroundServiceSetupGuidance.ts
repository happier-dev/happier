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
  const shouldSwitchDefaultReleaseChannel = params.guidance.shouldOfferDefaultReleaseChannelSwitch
    ? await params.promptSwitchDefaultReleaseChannel()
    : false;

  if (params.guidance.shouldOfferDefaultReleaseChannelSwitch && !shouldSwitchDefaultReleaseChannel) {
    return {
      cancelled: true,
      cancellationReason: 'declined_release_channel_switch',
      switchedDefaultReleaseChannel: false,
      replacedExistingServices: false,
    };
  }

  const shouldReplaceExistingServices = params.guidance.shouldPromptForServiceReplacement
    ? await params.promptReplaceExistingServices()
    : false;

  if (params.guidance.shouldPromptForServiceReplacement && !shouldReplaceExistingServices) {
    return {
      cancelled: true,
      cancellationReason: 'declined_service_replacement',
      switchedDefaultReleaseChannel: false,
      replacedExistingServices: false,
    };
  }

  let switchedDefaultReleaseChannel = false;
  if (shouldSwitchDefaultReleaseChannel) {
    await params.switchDefaultReleaseChannel();
    switchedDefaultReleaseChannel = true;
  }

  let replacedExistingServices = false;
  if (shouldReplaceExistingServices) {
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
