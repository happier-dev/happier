export {
  bindCurrentUiContextVoiceToolPortToAdmission,
} from '@/components/appShell/currentUiContext/currentUiContextVoiceToolPort';
import type { CurrentUiContextVoiceToolPort } from '@/components/appShell/currentUiContext/currentUiContextVoiceToolPort';

/**
 * Narrow provider-owned capability passed into one Voice runtime assembly.
 * The port is client-local and attempt-scoped by its consumers; it neither
 * materializes snapshots nor retains semantic payloads outside the AppShell
 * current-context owner.
 */
export type VoiceCurrentUiToolPort = CurrentUiContextVoiceToolPort;
