import { t } from '@/text';

/**
 * What "Hear a sample" says when the voice engine could not speak it. The reason is the structural
 * code the operation result carries; the person gets the matching machine state in their words, or
 * engine-neutral advice, never the code itself.
 */
export function describeTtsSampleFailure(reason: string | null): string {
  switch (reason) {
    case 'machine_unreachable':
    case 'execution_machine_unavailable':
      return t('settingsVoice.local.daemonInference.states.machineUnreachable');
    case 'request_timeout':
      return t('settingsVoice.local.daemonInference.states.requestTimeout');
    case 'feature_disabled':
      return t('settingsVoice.local.daemonInference.states.unavailable');
    case 'model_not_installed':
      return t('settingsVoice.local.daemonInference.model.subtitleTts');
    case 'runtime_unavailable':
    case 'unsupported_runtime_family':
      return t('settingsVoice.local.daemonInference.states.runtimeUnavailable');
    default:
      return t('settingsVoice.local.testTtsFailed');
  }
}
