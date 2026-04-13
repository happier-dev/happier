import type { BackgroundServiceSetupGuidance } from './buildBackgroundServiceSetupGuidance.js';

export type BackgroundServiceSetupGuidanceCancellationReason =
  | 'declined_release_channel_switch'
  | 'declined_manual_relay_takeover'
  | 'declined_service_replacement';

export type BackgroundServiceSetupGuidanceFlowResult = Readonly<{
  cancelled: boolean;
  cancellationReason: BackgroundServiceSetupGuidanceCancellationReason | null;
  switchedDefaultReleaseChannel: boolean;
  tookOverManualRelayRuntime: boolean;
  replacedExistingServices: boolean;
}>;

export async function applyBackgroundServiceSetupGuidance(params: Readonly<{
  guidance: BackgroundServiceSetupGuidance;
  promptSwitchDefaultReleaseChannel: () => Promise<boolean>;
  promptTakeOverManualRelayRuntime: () => Promise<boolean>;
  promptReplaceExistingServices: () => Promise<boolean>;
  switchDefaultReleaseChannel: () => Promise<void>;
  takeOverManualRelayRuntime: () => Promise<void>;
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
      tookOverManualRelayRuntime: false,
      replacedExistingServices: false,
    };
  }

  const shouldTakeOverManualRelayRuntime = params.guidance.shouldPromptForManualRelayTakeover
    ? await params.promptTakeOverManualRelayRuntime()
    : false;

  if (params.guidance.shouldPromptForManualRelayTakeover && !shouldTakeOverManualRelayRuntime) {
    return {
      cancelled: true,
      cancellationReason: 'declined_manual_relay_takeover',
      switchedDefaultReleaseChannel: false,
      tookOverManualRelayRuntime: false,
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
      tookOverManualRelayRuntime: false,
      replacedExistingServices: false,
    };
  }

  let switchedDefaultReleaseChannel = false;
  if (shouldSwitchDefaultReleaseChannel) {
    await params.switchDefaultReleaseChannel();
    switchedDefaultReleaseChannel = true;
  }

  let tookOverManualRelayRuntime = false;
  if (shouldTakeOverManualRelayRuntime) {
    await params.takeOverManualRelayRuntime();
    tookOverManualRelayRuntime = true;
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
    tookOverManualRelayRuntime,
    replacedExistingServices,
  };
}
