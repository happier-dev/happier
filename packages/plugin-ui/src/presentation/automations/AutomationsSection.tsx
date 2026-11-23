import { useMemo, type ComponentType, type ReactElement, type ReactNode, type RefObject } from 'react';
import { StyleSheet, View } from 'react-native';

import type { HappierSurfaceStateAction } from '../state/SurfaceState.js';

type VoidAction = () => void;
type GroupProps = Readonly<{
  testID?: string;
  constrainToContentWidth?: boolean;
  title?: string;
  description?: string;
  titleRole?: 'label';
  action?: ReactNode;
  surface?: 'none';
  children: ReactNode;
}>;

type SectionReadState = Readonly<{ kind: 'loading' }> | Readonly<{
  kind: 'failed';
  reason: string;
  onRetry?: () => void | Promise<unknown>;
}>;

/** The physical host supplies its existing list, widget and control primitives. */
export type HappierAutomationsSectionBindings = Readonly<{
  Group: ComponentType<GroupProps>;
  PagePresentation: ComponentType<Readonly<{ value: 'page'; pageInsets: 'contained'; children: ReactNode }>>;
  RowDensity: ComponentType<Readonly<{ value: 'inspector'; children: ReactNode }>>;
  WidgetDescription: ComponentType<Readonly<{ variant: 'fact'; titleSentence: true; title: string; testID: string }>>;
  WidgetHeaderActions: ComponentType<Readonly<{ node: ReactNode }>>;
  ActionBar: ComponentType<Readonly<{ anchor?: RefObject<View | null>; children: ReactNode }>>;
  LoadStateRows: ComponentType<Readonly<{ testID: string; rows: number; accessibilityLabel: string; state: SectionReadState }>>;
  StateLine: ComponentType<Readonly<{
    testID: string; size: 'line'; kind: 'unavailable' | 'empty'; title: string; action?: HappierSurfaceStateAction;
  }>>;
  FreshnessLine: ComponentType<Readonly<{ testID: string; tone: 'warning'; reason: string; action: HappierSurfaceStateAction }>>;
  MoreRow: ComponentType<Readonly<{ testID: string; title: string; showChevron: false; onPress: VoidAction }>>;
  SectionButton: ComponentType<Readonly<{
    testID?: string; icon: 'link' | 'plus'; title: string; expanded?: boolean; disabled?: boolean; onPress: VoidAction;
  }>>;
  IconButton: ComponentType<Readonly<{
    testID?: string; iconName: 'link' | 'plus'; variant: 'plain'; accessibilityLabel: string; tooltip?: string;
    expanded?: boolean; disabled?: boolean; onPress: VoidAction;
  }>>;
}>;

type SectionLink = Readonly<{ kind: 'held' }> | Readonly<{
  kind: 'offered'; expanded: boolean; onPress: VoidAction;
}>;

type SectionControls = Readonly<{
  automateLabel: string;
  linkLabel: string;
  link: SectionLink | null;
  addAnchor: RefObject<View | null>;
  linkAnchor: RefObject<View | null>;
  onAutomate: VoidAction;
}>;

type StartNotice = Readonly<{ kind: 'offline' | 'unavailable'; title: string; action?: HappierSurfaceStateAction }>;

/** The same page section or widget body consumes held automation facts from the core controller. */
export function HappierAutomationsSection(props: Readonly<{
  bindings: HappierAutomationsSectionBindings;
  testID?: string;
  page: boolean;
  widget?: boolean;
  title: string;
  description: string;
  controls?: SectionControls;
  leading?: ReactNode;
  readState?: SectionReadState;
  rows?: ReactNode;
  startNotice?: StartNotice;
  children?: ReactNode;
  persistentStarters?: ReactNode;
  emptyTitle?: string;
  notSharedTitle?: string;
  more?: HappierSurfaceStateAction;
  freshness?: Readonly<{ reason: string; action: HappierSurfaceStateAction }>;
  also?: Readonly<{ title: string; rows: ReactNode }>;
}>): ReactElement {
  const { Group, PagePresentation, RowDensity, WidgetDescription, WidgetHeaderActions, ActionBar,
    LoadStateRows, StateLine, FreshnessLine, MoreRow, SectionButton, IconButton } = props.bindings;
  const { widget, controls, startNotice } = props;
  const { automateLabel, linkLabel, link, addAnchor, linkAnchor, onAutomate } = controls ?? {};
  const linkKind = link?.kind;
  const linkExpanded = link?.kind === 'offered' ? link.expanded : undefined;
  const onLink = link?.kind === 'offered' ? link.onPress : undefined;
  // The frame retains the node it borrows from its body. Change it only when the visible controls change.
  const frameActions = useMemo(() => widget && automateLabel !== undefined && linkLabel !== undefined && onAutomate ? (
    <ActionBar>
      {linkKind === 'offered' && onLink ? (
        <View ref={linkAnchor} collapsable={false}>
          <IconButton testID="subject-triggers-link" iconName="link" variant="plain" expanded={linkExpanded}
            accessibilityLabel={linkLabel} tooltip={linkLabel} onPress={onLink} />
        </View>
      ) : linkKind === 'held' ? (
        <View testID="subject-triggers-link-pending" style={styles.heldSlot} pointerEvents="none"
          aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <IconButton iconName="link" variant="plain" accessibilityLabel={linkLabel} disabled onPress={() => {}} />
        </View>
      ) : null}
      <View ref={addAnchor} collapsable={false}>
        <IconButton testID="subject-triggers-add" iconName="plus" variant="plain"
          accessibilityLabel={automateLabel} tooltip={automateLabel} onPress={onAutomate} />
      </View>
    </ActionBar>
  ) : null, [widget, automateLabel, linkLabel, linkKind, linkExpanded, onAutomate, onLink, linkAnchor, addAnchor, IconButton, ActionBar]);
  // Page controls stay keyed, with Automate ahead of Link even while Link's space is held.
  const sectionActions = widget || !controls ? null : (
    <ActionBar anchor={controls.addAnchor}>
      <SectionButton key="automate" testID="subject-triggers-add" icon="plus" title={controls.automateLabel} onPress={controls.onAutomate} />
      {link?.kind === 'offered' ? (
        <View key="link" ref={controls.linkAnchor} collapsable={false}>
          <SectionButton testID="subject-triggers-link" icon="link" title={controls.linkLabel}
            expanded={link.expanded} onPress={link.onPress} />
        </View>
      ) : link?.kind === 'held' ? (
        <View key="link" testID="subject-triggers-link-pending" style={styles.heldSlot} pointerEvents="none"
          aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <SectionButton icon="link" title={controls.linkLabel} disabled onPress={() => {}} />
        </View>
      ) : null}
    </ActionBar>
  );
  const content = <>
    {props.leading}
    {props.readState ? <LoadStateRows testID="subject-triggers-read" rows={2} accessibilityLabel={props.title} state={props.readState} /> : props.rows}
    {startNotice ? <StateLine testID={`subject-triggers-starts-${startNotice.kind}`} size="line"
      kind="unavailable" title={startNotice.title} action={startNotice.action} /> : null}
    {props.children}
    {props.persistentStarters}
    {props.emptyTitle === undefined ? null : <StateLine testID="subject-triggers-empty" size="line" kind="empty" title={props.emptyTitle} />}
    {props.notSharedTitle === undefined ? null : <StateLine testID="subject-triggers-not-shared" size="line" kind="unavailable" title={props.notSharedTitle} />}
    {props.more ? <MoreRow testID="subject-triggers-more" title={props.more.label} showChevron={false} onPress={props.more.onPress} /> : null}
    {props.freshness ? <FreshnessLine testID="subject-triggers-read" tone="warning" {...props.freshness} /> : null}
  </>;
  // Give a plugin page the same section anatomy, using the column's existing width and inset.
  const section = <Group testID={props.testID ?? 'subject-triggers'}
    {...(props.page || widget ? {} : { constrainToContentWidth: false })}
    {...(widget ? { surface: 'none' as const } : { title: props.title, description: props.description, action: sectionActions })}>
    {widget ? <WidgetDescription variant="fact" titleSentence title={props.description} testID="subject-triggers-description" /> : null}
    {widget ? <RowDensity value="inspector">{content}</RowDensity> : content}
  </Group>;
  return <>
    {frameActions ? <WidgetHeaderActions node={frameActions} /> : null}
    {widget || props.page ? section : <PagePresentation value="page" pageInsets="contained">{section}</PagePresentation>}
    {props.also ? <Group testID="subject-triggers-also" titleRole="label" title={props.also.title}>{props.also.rows}</Group> : null}
  </>;
}

const styles = StyleSheet.create({
  heldSlot: { opacity: 0 },
});
