import type { SupportedLanguage } from '../_all';

export const paneArrangementTranslations = {
  en: { paneArrangement: 'Pane arrangement', paneArrangementDescription: 'Choose whether the session or editor sits in the middle.' , paneArrangementSession: 'Session first', paneArrangementEditor: 'Editor first', paneArrangementSessionCaption: 'Chat in the middle', paneArrangementEditorCaption: 'Code in the middle', rightPanelPlacement: 'Right panel separation', rightPanelPlacementDescription: 'Choose how the right panel stands against the page: on its own, or joined by a line or a soft shadow.', rightPanelPlacementSeparate: 'Separate', rightPanelPlacementLine: 'Line', rightPanelPlacementShadow: 'Shadow', rightPanelPlacementSeparateCaption: 'Its own sheet beside the page', rightPanelPlacementLineCaption: 'Joined by a thin line', rightPanelPlacementShadowCaption: 'Joined by a soft shadow' },
} as const satisfies Pick<Record<SupportedLanguage, Readonly<{ paneArrangement: string; paneArrangementDescription: string; paneArrangementSession: string; paneArrangementEditor: string; paneArrangementSessionCaption: string; paneArrangementEditorCaption: string; rightPanelPlacement: string; rightPanelPlacementDescription: string; rightPanelPlacementSeparate: string; rightPanelPlacementLine: string; rightPanelPlacementShadow: string; rightPanelPlacementSeparateCaption: string; rightPanelPlacementLineCaption: string; rightPanelPlacementShadowCaption: string }>>, 'en'>;

export const paneRegionLabels = {
  en: { rail: 'App navigation', navigation: 'Navigation column', right: 'Side panel', details: 'Editor and details', main: 'Main column', bottom: 'Bottom panel' },
} as const satisfies Pick<Record<SupportedLanguage, Readonly<Record<'rail' | 'navigation' | 'right' | 'details' | 'main' | 'bottom', string>>>, 'en'>;

export type PaneKeyboardCopy = Readonly<{
  commands: Readonly<{ shellColumnToggle: string; panesMainToggle: string; panesSideToggle: string; panesArrangementToggle: string; panesRegionNext: string; panesRegionPrevious: string }>;
  groups: Readonly<{ panes: string; terminal: string; search: string; review: string; files: string; code: string }>;
  desktop: string;
  browser: string;
}>;

export const paneKeyboardTranslations = {
  en: { commands: { shellColumnToggle: 'Show or hide navigation', panesMainToggle: 'Show or hide main column', panesSideToggle: 'Show or hide side panel', panesArrangementToggle: 'Switch pane arrangement', panesRegionNext: 'Focus next region', panesRegionPrevious: 'Focus previous region' }, groups: { panes: 'Panes', terminal: 'Terminal', search: 'Search', review: 'Review', files: 'Files and editor', code: 'Code intelligence' }, desktop: 'Desktop app', browser: 'Browser' },
} as const satisfies Pick<Record<SupportedLanguage, PaneKeyboardCopy>, 'en'>;
