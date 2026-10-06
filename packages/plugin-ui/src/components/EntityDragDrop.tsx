import { createContext, useContext, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { Platform } from 'react-native';
import { bindHostedEntityDragSource, bindHostedEntityDropTarget } from '@happier-dev/plugin-sdk/ui/client';
import type { PluginHostedEntityDragSourceMount } from '@happier-dev/plugin-sdk/ui/client';
import type { PluginUiEntityDropDestinationV1, PluginUiEntityDragDropStateV1 } from '@happier-dev/plugin-sdk/ui';

import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { usePluginHostApi } from '../hostApi/context.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';
import { HappierDragGripTrigger } from '../presentation/interaction/DragGrip.js';
import { HappierDropTargetOutline } from '../presentation/interaction/DropTargetOutline.js';
import { HappierStagedMoveDock, type HappierReleasePreviewHost } from '../presentation/interaction/ReleasePreview.js';
import { resolveHappierStagedMoveKey, resolveHappierDropChooserSections } from '../presentation/interaction/dragDrop.js';
import { describeHappierDropAnnouncement, describeHappierDropOutcome, resolveHappierStagedMoveHints, type HappierDropOutcomeVocabulary } from '../presentation/interaction/dropOutcome.js';
import { HappierText } from '../presentation/text/Text.js';
import { resolveHappierMinimumInteractiveTargetSize } from '../environment/interactiveTarget.js';
import { HostedAnchoredMenu } from './Overlay.js';

const HostedPreviewText: HappierReleasePreviewHost['Text'] = props => <HappierText {...props} />;
// A hosted realm has no host icon pack: the outcome's words carry it, never a stand-in mark.
const HOSTED_PREVIEW_HOST: HappierReleasePreviewHost = { Text: HostedPreviewText, renderGlyph: () => null };

/** The hosted realm's words for the one outcome presenter; the host realm words its own the same way. */
function hostedDropVocabulary(translate: ReturnType<typeof usePluginTranslation>): HappierDropOutcomeVocabulary {
  return {
    pendingDetail: translate('entityDrag.pending', 'Waiting to confirm'),
    refusedTitle: translate('entityDrag.cantMoveHere', 'Can’t move it here'),
    lateRefusalTitle: (effect) => `${effect.preview.verb} · ${translate('entityDrag.refused', 'didn’t go through')}`,
    unknownTitle: (effect) => `${effect.preview.verb} · ${translate('entityDrag.unknown', 'not sure it went through')}`,
    unknownDetail: translate('entityDrag.unknownDetail', 'Check in a moment before trying again'),
  };
}
const destinationKey = (destination: PluginUiEntityDropDestinationV1) => `${destination.targetId}\u0000${JSON.stringify(destination.destination ?? null)}`;
function gripGlyph(color: string, size: number): ReactNode {
  return <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden>{[4, 9, 14].flatMap(y => [6, 12].map(x => <circle key={`${x}:${y}`} cx={x} cy={y} r="1.4" fill={color} />))}</svg>;
}

const HostedDropParent = createContext<string | undefined>(undefined);
function HostedDragSource(props: DragSourceProps): ReactElement {
  const hostApi = usePluginHostApi();
  const element = useRef<HTMLDivElement>(null);
  const grip = useRef<HTMLElement | null>(null);
  const mount = useRef<PluginHostedEntityDragSourceMount | null>(null);
  const staged = useRef(false);
  const chosenIndex = useRef(0);
  const [destinations, setDestinations] = useState<readonly PluginUiEntityDropDestinationV1[]>([]);
  const destinationsRef = useRef(destinations);
  destinationsRef.current = destinations;
  const [chosen, setChosen] = useState<PluginUiEntityDropDestinationV1 | null>(null);
  const [chooser, setChooser] = useState(false);
  const theme = usePluginTheme();
  const translate = usePluginTranslation();
  const mountId = useId();
  const reference = useRef(props.reference);
  reference.current = props.reference;
  const referenceKey = JSON.stringify(props.reference);
  useEffect(() => {
    if (!element.current || props.disabled) return;
    const binding = bindHostedEntityDragSource({ hostApi, element: element.current, mountId, sourceId: props.sourceId, reference: reference.current, ...(grip.current ? { handle: grip.current } : {}),
      onState: state => {
        setDestinations(state.destinations); destinationsRef.current = state.destinations;
        if (!state.current || (staged.current && (state.phase === 'idle' || state.phase === 'settled'))) {
          staged.current = false; setChosen(null); setChooser(false);
        } else if (state.admission === null) setChosen(null);
        else { const admission = state.admission; setChosen(previous => previous ? { ...previous, admission } : previous); }
      },
      onError: () => { element.current?.setAttribute('draggable', 'false'); } });
    mount.current = binding;
    void binding.ready.catch(() => undefined);
    return () => { staged.current = false; mount.current = null; setChosen(null); setChooser(false); binding.dispose(); };
  }, [hostApi, mountId, props.sourceId, referenceKey, props.disabled, props.organizing]);
  const reset = () => { staged.current = false; setChosen(null); setChooser(false); };
  const pickUp = async () => {
    const binding = mount.current;
    if (!binding || !await binding.ready) return;
    const places = await binding.destinations();
    if (mount.current !== binding || !places.accepted) return;
    const values = places.destinations ?? [];
    setDestinations(values); destinationsRef.current = values;
    const started = await binding.beginKeyboard();
    if (mount.current !== binding || !started.accepted) return;
    staged.current = true; chosenIndex.current = 0;
    const first = values[0];
    if (first) { await binding.choose(first); if (mount.current === binding) setChosen(first); }
  };
  const selected = chosen?.admission;
  const vocabulary = hostedDropVocabulary(translate);
  const outcome = chosen ? describeHappierDropOutcome({ phase: 'carrying', admission: selected ?? null }, vocabulary)
    ?? { tone: 'refused' as const, title: vocabulary.refusedTitle } : null;
  const announcement = describeHappierDropAnnouncement(outcome);
  const hints = resolveHappierStagedMoveHints({ rtl: element.current?.ownerDocument.dir === 'rtl', labels: {
    choose: translate('entityDrag.choose', 'Choose'), drop: translate('entityDrag.drop', 'Drop'),
    cancel: translate('entityDrag.cancel', 'Cancel'), escapeKey: translate('entityDrag.escapeKey', 'esc'),
  } });
  const sections = resolveHappierDropChooserSections({ unavailableTitle: translate('entityDrag.unavailable', 'Unavailable'), options: destinations.map(destination => ({
    id: destinationKey(destination), label: destination.label ?? (destination.admission.status === 'allowed' ? destination.admission.effect.preview.target : destination.admission.reason.message), group: destination.group,
    ...(destination.admission.status === 'refused' ? { refusedReason: destination.admission.reason.message } : {}),
  })) });
  const handleKeyDown = (key: string, repeat: boolean): boolean => {
    const intent = resolveHappierStagedMoveKey({ key, staged: staged.current, repeat, rtl: element.current?.ownerDocument.dir === 'rtl' });
    if (!intent || !mount.current) return false;
    if (intent === 'pickUp') { void pickUp(); return true; }
    if (intent === 'cancel') { void mount.current.cancel(); reset(); return true; }
    if (intent === 'drop') { const binding = mount.current; void binding.commit().then(() => { if (mount.current === binding) reset(); }); return true; }
    const values = destinationsRef.current;
    const direction = intent === 'previous' || intent === 'out' ? -1 : 1;
    chosenIndex.current = Math.min(Math.max(0, chosenIndex.current + direction), Math.max(0, values.length - 1));
    const destination = values[chosenIndex.current];
    if (destination) { setChosen(destination); void mount.current.choose(destination); }
    return true;
  };
  return <div ref={element} data-testid={props.testID} role="group" aria-label={translate('entityDrag.move', 'Move item')} tabIndex={props.disabled ? undefined : 0} onKeyDown={event => {
    if (event.target !== event.currentTarget || !handleKeyDown(event.key, event.repeat)) return;
    event.preventDefault(); event.stopPropagation();
  }}>{props.children}<div role="status" aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)' }}>{announcement ?? ''}</div>
    {props.organizing && !props.disabled ? <HappierDragGripTrigger
      controlRef={node => { grip.current = node instanceof HTMLElement ? node : null; }}
      testID={props.testID ? `${props.testID}-grip` : undefined} accessibilityLabel={translate('entityDrag.move', 'Move item')}
      expanded={chooser} density="touch" minimumTargetSize={resolveHappierMinimumInteractiveTargetSize(Platform.OS)}
      colors={{ glyph: theme.colors.secondaryText, activeGlyph: theme.colors.accent, activeFill: theme.colors.control, hoverFill: theme.colors.control, focusRing: theme.colors.focus }}
      onKeyDown={(key, event) => handleKeyDown(key, typeof event === 'object' && event !== null && 'repeat' in event && event.repeat === true)}
      renderGlyph={gripGlyph} onPress={() => {
      const binding = mount.current;
      if (!binding || staged.current) return;
      void binding.destinations().then(result => { if (mount.current === binding && result.accepted) { setDestinations(result.destinations ?? []); setChooser(true); } });
    }} /> : null}
    {outcome ? <HappierStagedMoveDock outcome={outcome} hints={hints} colors={{ surface: theme.colors.surface, border: theme.colors.border, divider: theme.colors.divider, text: theme.colors.text, textSecondary: theme.colors.secondaryText, accent: theme.colors.accent, allowedFill: theme.colors.control, refusedFill: theme.colors.controlDisabled, keycapFill: theme.colors.control, shadow: theme.colors.overlay }} host={HOSTED_PREVIEW_HOST} /> : null}
    {chooser ? <HostedAnchoredMenu anchorRef={grip} onOpenChange={setChooser} accessibilityLabel={translate('entityDrag.choose', 'Choose destination')}
      items={sections.filter(section => section.title === undefined).flatMap(section => section.options.map(option => ({ id: option.id, label: option.label, subtitle: option.detail, disabled: option.disabled })))}
      groups={sections.filter(section => section.title !== undefined).map(section => ({ id: section.id, accessibilityLabel: section.title!, items: section.options.map(option => ({ id: option.id, label: option.label, subtitle: option.detail, disabled: option.disabled })) }))}
      onSelect={id => {
        const destination = destinationsRef.current.find(value => destinationKey(value) === id); const binding = mount.current;
        if (destination && binding) void binding.perform(destination).then(() => { if (mount.current === binding) reset(); });
      }} /> : null}
  </div>;
}
function HostedDropTarget(props: DropTargetProps): ReactElement {
  const hostApi = usePluginHostApi();
  const theme = usePluginTheme();
  const [feedback, setFeedback] = useState<PluginUiEntityDragDropStateV1 | null>(null);
  const element = useRef<HTMLDivElement>(null);
  const mountId = useId();
  const parentId = useContext(HostedDropParent);
  const targetInput = useRef(props.input);
  targetInput.current = props.input;
  const inputKey = JSON.stringify(props.input ?? null);
  useEffect(() => {
    if (!element.current || props.disabled) return;
    const mount = bindHostedEntityDropTarget({ hostApi, element: element.current, mountId, targetId: props.targetId,
      onState: setFeedback,
      ...(targetInput.current === undefined ? {} : { input: targetInput.current }), ...(parentId === undefined ? {} : { parentId }) });
    void mount.ready.catch(() => undefined);
    return () => { setFeedback(null); mount.dispose(); };
  }, [hostApi, mountId, parentId, props.targetId, inputKey, props.disabled]);
  const active = !props.disabled && feedback?.current && feedback.admission?.status === 'allowed' && (feedback.phase === 'carrying' || feedback.phase === 'pending');
  return <HostedDropParent.Provider value={props.disabled ? parentId : mountId}><div ref={element} data-testid={props.testID} aria-busy={active && feedback?.phase === 'pending' ? true : undefined} style={{ position: 'relative' }}>{props.children}
    {active ? <HappierDropTargetOutline testID={props.testID ? `${props.testID}-outline` : undefined} colors={{ border: theme.colors.accent, background: theme.colors.control }} style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }} /> : null}
  </div></HostedDropParent.Provider>;
}

/** An instance of this plugin's manifest-declared source, never a caller-built host identity. */
export type DragSourceProps = Readonly<{
  sourceId: string;
  reference: JsonValue;
  children: ReactNode;
  disabled?: boolean;
  /** Touch dragging is offered only while the surrounding list is intentionally organizing. */
  organizing?: boolean;
  testID?: string;
}>;

/** A mounted instance of this plugin's declared target; its registration resolves admitted Actions. */
export type DropTargetProps = Readonly<{
  targetId: string;
  input?: JsonValue;
  children: ReactNode;
  disabled?: boolean;
  testID?: string;
}>;

/** Physical input, reference validation and retirement belong to the mounted host. */
export function DragSource(props: DragSourceProps): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  return <>{host?.renderDragSource ? host.renderDragSource(props) : Platform.OS === 'web' ? <HostedDragSource {...props} /> : props.children}</>;
}

/** Every presentation realm rejoins the same target registry and Action admission owner. */
export function DropTarget(props: DropTargetProps): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  return <>{host?.renderDropTarget ? host.renderDropTarget(props) : Platform.OS === 'web' ? <HostedDropTarget {...props} /> : props.children}</>;
}
