import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';

import type { IconName } from '@/components/ui/icons/Icon';
import { readVoiceDiagnosticsSettings, voiceSettingsParse, type VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { t, tLoose } from '@/text';
import { createVoiceDictationRuntimeSettingsSnapshot } from '@/voice/dictation/voiceDictationRuntimeSettings';
import { parseLocalVoiceSttSettings, resolveLocalVoiceAdapterSettings } from '@/voice/local/localVoiceSettings';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { resolveSelectedVoiceProviderTitleKey } from '@/voice/registry/providerSelection';
import type { VoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import { getLocalSttProviderSpec } from '@/voice/settings/panels/localStt/providers/registry';
import { resolveVoicePipelineWhere } from '@/voice/settings/pipeline/presentVoicePipeline';
import {
  buildVoiceConversationsPipeline,
  buildVoiceDictationPipeline,
  type VoicePipelineMachine,
} from '@/voice/settings/pipeline/voicePipelineSteps';
import type { VoiceSettingsPipelineStep } from '@/voice/settings/projectVoiceSettingsPipeline';

import { projectVoiceProcessingDisclosures, type VoiceProcessingDisclosureProjection } from './projectVoiceProcessingDisclosures';

export type VoicePrivacyStop = Readonly<{ label: string; icon: IconName | null; strong: boolean }>;
export type VoicePrivacyRowKey = 'audio' | 'dictation' | 'replies' | 'reads' | 'recordings';
export type VoicePrivacyRow = Readonly<{ key: VoicePrivacyRowKey; title: string; stops: readonly VoicePrivacyStop[]; note: string | null }>;
export type VoicePrivacyPath = Readonly<{
  serviceTitle: string | null;
  rows: readonly VoicePrivacyRow[];
  details: readonly Readonly<{ id: string; title: string; text: string }>[];
}>;

type Facts = NonNullable<VoiceProcessingDisclosureProjection['facts']>;
type Reach = Readonly<{ stops: readonly VoicePrivacyStop[]; destination: string; disclosure: VoiceProcessingDisclosureProjection | null }>;

const defaultRegistry = createDefaultVoiceProviderRegistry();

function localized(value: string | Readonly<{ key: string; fallback: string }>): string {
  if (typeof value === 'string') return value;
  const translated = tLoose(value.key);
  return translated === value.key ? value.fallback : translated;
}

function thisDevice(strong: boolean): VoicePrivacyStop {
  return { label: t('settingsVoice.pages.privacy.pathThisDevice'), icon: 'laptop', strong };
}

/**
 * Where one speech step takes what it is given: through the Voice computer when it runs there, then
 * on to the service the provider declares, unless the host says the engine stays on the person's own
 * hardware. Placement and engine come from the pipeline owner, facts from the disclosure owner.
 */
function reachOf(
  step: VoiceSettingsPipelineStep,
  disclosure: VoiceProcessingDisclosureProjection | null,
  destinationFact: (facts: Facts) => string,
): Reach {
  const external = disclosure?.facts && !disclosure.localProcessing ? destinationFact(disclosure.facts) : null;
  // A hosted service's audio goes to the service; a machine it needs (for its sign-in) is not on that path.
  const machine = step.placement.kind === 'machine' && step.engine.kind !== 'service'
    ? step.placement.machineName ?? t('settingsVoice.pages.privacy.pathVoiceComputer')
    : null;
  const onward = [
    ...(machine ? [{ label: machine, icon: 'desktop', strong: !external } satisfies VoicePrivacyStop] : []),
    ...(external ? [{ label: external, icon: 'cloud', strong: true } satisfies VoicePrivacyStop] : []),
  ];
  return { stops: [thisDevice(onward.length === 0), ...onward], destination: onward.map((stop) => stop.label).join('>'), disclosure };
}

/** The clause after a path: audio that stays home says so; anything else states its keeper's terms. */
function reachNote(reach: Reach): string | null {
  const disclosure = reach.disclosure;
  if (!disclosure?.facts) return null;
  return disclosure.localProcessing ? t('settingsVoice.pages.privacy.staysLocal') : localized(disclosure.facts.retention);
}

function withEngines(reach: Reach, names: readonly string[]): string | null {
  const engines = names.length > 0 ? `(${Array.from(new Set(names)).join(', ')})` : null;
  return joinHappierFacts(engines, reachNote(reach)) || null;
}

function speechEngineName(step: VoiceSettingsPipelineStep): readonly string[] {
  return step.engine.kind === 'speech' ? [step.engine.title] : [];
}

function readsRow(step: VoiceSettingsPipelineStep, disclosure: VoiceProcessingDisclosureProjection | null): VoicePrivacyRow {
  const title = t('settingsVoice.pages.privacy.readsRowTitle');
  if (step.engine.kind === 'service') {
    return { key: 'reads', title, stops: [{ label: disclosure?.facts ? localized(disclosure.facts.processor) : step.engine.title, icon: 'cloud', strong: true }], note: null };
  }
  if (step.engine.kind === 'agent') {
    const where = resolveVoicePipelineWhere(step);
    return {
      key: 'reads',
      title,
      stops: [{ label: joinHappierFacts(step.engine.title, where.text) ?? step.engine.title, icon: where.icon, strong: true }],
      note: t('settingsVoice.pages.privacy.agentAccount'),
    };
  }
  return { key: 'reads', title, stops: [{ label: step.engine.title, icon: 'chat-circle', strong: true }], note: null };
}

/**
 * The privacy page's one block: where your audio goes and what reads your work, named by the actual
 * path. Pure over the pipeline owner (what runs where) and the disclosure owner (what each service
 * declares). Full disclosure text stays available as `details`, once.
 */
export function projectVoicePrivacyPath(input: Readonly<{
  voice: VoiceSettings;
  machine: VoicePipelineMachine;
  registry?: VoiceProviderRegistry;
}>): VoicePrivacyPath {
  const registry = input.registry ?? defaultRegistry;
  const voice = voiceSettingsParse(input.voice);
  const disclosures = projectVoiceProcessingDisclosures(voice, registry);
  const disclosureOf = (step: VoiceSettingsPipelineStep | undefined, role: 'stt' | 'tts'): VoiceProcessingDisclosureProjection | null => {
    if (!step) return null;
    const wanted = step.engine.kind === 'service' ? 'conversation' : role;
    const providerId = step.engine.kind === 'service' || step.engine.kind === 'speech' ? step.engine.providerId : undefined;
    return disclosures.find((entry) => entry.roles.includes(wanted) && (!providerId || entry.providerIds.includes(providerId))) ?? null;
  };
  const titleKey = resolveSelectedVoiceProviderTitleKey(voice, registry);
  const serviceTitle = titleKey ? tLoose(titleKey) : null;
  const pipeline = buildVoiceConversationsPipeline({ voice, serviceTitle, readiness: null, machine: input.machine, registry })?.pipeline ?? null;
  const steps = pipeline?.steps ?? [];
  const hear = steps.find((step) => step.roles.includes('hear'));
  const speak = steps.find((step) => step.roles.includes('speak'));
  const think = steps.find((step) => step.roles.includes('think'));

  const rows: VoicePrivacyRow[] = [];
  const hearReach = hear ? reachOf(hear, disclosureOf(hear, 'stt'), (facts) => localized(facts.audioDestination)) : null;
  const speakReach = speak && speak !== hear ? reachOf(speak, disclosureOf(speak, 'tts'), (facts) => localized(facts.processor)) : null;
  // Two facts name the same engine's destination differently (audio vs processor), so one provider
  // in one placement is one place whatever its facts call it.
  const sameEngine = Boolean(hear && speak && hear.engine.providerId && hear.engine.providerId === speak.engine.providerId
    && hear.placement.kind === speak.placement.kind);
  const speakSharesHearPlace = !speakReach || sameEngine || speakReach.destination === hearReach?.destination;
  if (hear && hearReach) {
    rows.push({
      key: 'audio',
      title: t('settingsVoice.pages.privacy.audioRowTitle'),
      stops: hearReach.stops,
      note: withEngines(hearReach, [...speechEngineName(hear), ...(speak && speakSharesHearPlace ? speechEngineName(speak) : [])]),
    });
  }
  if (speak && speakReach && !speakSharesHearPlace) {
    const replyText: VoicePrivacyStop = { label: t('settingsVoice.pages.privacy.pathReplyText'), icon: null, strong: false };
    const onward = speakReach.stops.slice(1);
    rows.push({
      key: 'replies',
      title: t('settingsVoice.pages.privacy.repliesRowTitle'),
      stops: [replyText, ...(onward.length > 0 ? onward : [thisDevice(true)])],
      note: withEngines(speakReach, speechEngineName(speak)),
    });
  }
  if (think) rows.push(readsRow(think, disclosureOf(think, 'stt')));

  const dictationStt = parseLocalVoiceSttSettings(resolveLocalVoiceAdapterSettings(createVoiceDictationRuntimeSettingsSnapshot({ voice })).config.stt);
  const dictationSpec = getLocalSttProviderSpec(dictationStt.provider, 'dictation_stt');
  const dictationHear = buildVoiceDictationPipeline({
    sttProviderId: dictationStt.provider,
    sttTitle: dictationSpec?.title ?? dictationStt.provider,
    localNeuralExecution: dictationStt.localNeural?.execution ?? null,
    readiness: null,
    machine: input.machine,
    registry,
  }).steps.find((step) => step.roles.includes('hear'));
  if (dictationHear) {
    const reach = reachOf(dictationHear, disclosureOf(dictationHear, 'stt'), (facts) => localized(facts.audioDestination));
    if (!hearReach || reach.destination !== hearReach.destination) {
      rows.push({ key: 'dictation', title: t('settingsVoice.intents.dictation.title'), stops: reach.stops, note: withEngines(reach, speechEngineName(dictationHear)) });
    }
  }

  rows.push({
    key: 'recordings',
    title: t('settingsVoice.pages.privacy.recordingsRowTitle'),
    stops: [{ label: readVoiceDiagnosticsSettings(voice).enabled ? t('settingsVoice.pages.privacy.recordingOn') : t('settingsVoice.pages.privacy.recordingOff'), icon: null, strong: false }],
    note: null,
  });

  const details = disclosures.flatMap((entry) => {
    const text = [entry.disclosure, entry.facts?.details].filter((value) => value != null).map(localized).join('\n\n');
    return text ? [{ id: entry.id, title: tLoose(entry.titleKey), text }] : [];
  });
  return { serviceTitle, rows, details };
}
