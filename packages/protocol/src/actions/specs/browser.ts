import { z } from 'zod';

import type { RuntimeActionIdV1 } from '../actionIds.js';
import { BrowserAutomationActionRequestV1Schema, BrowserAutomationActionResultV1Schema, BrowserAutomationTimelineV1Schema } from '../../browser/automation/v1.js';
import { BrowserCommandDispatchResultV1Schema, BrowserCommandV1Schema } from '../../browser/control/v1.js';
import {
  BrowserAnnotationStyleIntentV1Schema,
  BrowserContextAttachmentV1Schema,
  BrowserContextCommandV1Schema,
  BrowserContextRouteResultV1Schema,
} from '../../browser/context/v1.js';
import {
  BrowserDiagnosticsElementPickerRequestV1Schema,
  BrowserDiagnosticsElementPickerResultV1Schema,
  BrowserDiagnosticsEvalRequestV1Schema,
  BrowserDiagnosticsEvalResultV1Schema,
  BrowserDiagnosticsGetPropertiesRequestV1Schema,
  BrowserDiagnosticsGetPropertiesResultV1Schema,
  BrowserDiagnosticsReleaseObjectGroupRequestV1Schema,
  BrowserDiagnosticsReleaseObjectGroupResultV1Schema,
  BrowserDiagnosticsSnapshotV1Schema,
} from '../../browser/diagnostics/v1.js';
import {
  BrowserEvidenceArtifactV1Schema,
  DaemonBrowserRecordingCancelInputV1Schema,
  DaemonBrowserRecordingCleanupInputV1Schema,
  DaemonBrowserRecordingCleanupResultV1Schema,
  DaemonBrowserRecordingListInputV1Schema,
  DaemonBrowserRecordingStartInputV1Schema,
  DaemonBrowserRecordingStartResultV1Schema,
  DaemonBrowserRecordingStatusInputV1Schema,
  DaemonBrowserRecordingStopInputV1Schema,
  DaemonBrowserRecordingStopResultV1Schema,
  DaemonBrowserRecordingTerminalResultV1Schema,
} from '../../browser/recording/v1.js';
import { refineKindSchema, type RuntimeActionSpecFamily } from './common.js';

const RuntimeBrowserViewInputSchema = z
  .object({
    browserSessionId: z.string().trim().min(1).max(256),
    viewId: z.string().trim().min(1).max(256),
  })
  .passthrough();

const RuntimeBrowserContextActionInputSchema = RuntimeBrowserViewInputSchema.extend({
  navigationGeneration: z.number().int().nonnegative().optional(),
  contextId: z.string().trim().min(1).max(256).optional(),
  annotationId: z.string().trim().min(1).max(256).optional(),
  command: BrowserContextCommandV1Schema.optional(),
  comment: z.string().trim().min(1).max(2048).optional(),
  styleIntent: BrowserAnnotationStyleIntentV1Schema.optional(),
}).passthrough();

const RuntimeBrowserRecordingAttachInputSchema = z
  .object({
    recordingId: z.string().trim().min(1).max(256),
    sessionId: z.string().trim().min(1).max(256).optional(),
  })
  .passthrough();

export const BROWSER_RUNTIME_ACTION_TITLES: Readonly<Partial<Record<RuntimeActionIdV1, string>>> = Object.freeze({
  'browser.session.create': 'Create browser session',
  'browser.session.close': 'Close browser session',
  'browser.view.open': 'Open browser view',
  'browser.view.close': 'Close browser view',
  'browser.view.focus': 'Focus browser view',
  'browser.target.set': 'Set browser target',
  'browser.navigate': 'Navigate browser',
  'browser.reload': 'Reload browser',
  'browser.goBack': 'Go back in browser',
  'browser.goForward': 'Go forward in browser',
  'browser.stop': 'Stop browser load',
  'browser.diagnostics.snapshot': 'Get browser diagnostics snapshot',
  'browser.diagnostics.clear': 'Clear browser diagnostics',
  'browser.diagnostics.pause': 'Pause browser diagnostics',
  'browser.diagnostics.resume': 'Resume browser diagnostics',
  'browser.diagnostics.eval': 'Evaluate browser diagnostics expression',
  'browser.diagnostics.getProperties': 'Get browser remote object properties',
  'browser.diagnostics.releaseObjectGroup': 'Release browser remote object group',
  'browser.diagnostics.elementPicker.start': 'Start browser element picker',
  'browser.diagnostics.elementPicker.cancel': 'Cancel browser element picker',
  'browser.context.capturePage': 'Capture browser page context',
  'browser.context.captureScreenshot': 'Capture browser screenshot context',
  'browser.context.captureSelectedElement': 'Capture selected browser element',
  'browser.context.captureNetworkSummary': 'Capture browser network summary',
  'browser.context.captureConsoleSummary': 'Capture browser console summary',
  'browser.context.annotation.start': 'Start browser annotation',
  'browser.context.annotation.cancel': 'Cancel browser annotation',
  'browser.context.annotation.captureRegion': 'Capture browser annotation region',
  'browser.context.annotation.captureElement': 'Capture browser annotation element',
  'browser.context.annotation.attachComment': 'Attach browser annotation comment',
  'browser.context.annotation.attachStroke': 'Attach browser annotation stroke',
  'browser.context.annotation.attachStyleIntent': 'Attach browser annotation style intent',
  'browser.context.attachToComposer': 'Attach browser context to composer',
  'browser.context.attachToAgentTurn': 'Attach browser context to agent turn',
  'browser.context.clear': 'Clear browser context',
  'browser.automation.status': 'Get browser automation status',
  'browser.automation.snapshot': 'Capture browser automation snapshot',
  'browser.automation.semanticSnapshot': 'Capture browser semantic snapshot',
  'browser.automation.queryElements': 'Query browser elements',
  'browser.automation.waitFor': 'Wait for browser condition',
  'browser.automation.timeline.get': 'Get browser automation timeline',
  'browser.automation.cancelActive': 'Cancel active browser automation',
  'browser.automation.navigate': 'Automate browser navigation',
  'browser.automation.reload': 'Automate browser reload',
  'browser.automation.goBack': 'Automate browser back navigation',
  'browser.automation.goForward': 'Automate browser forward navigation',
  'browser.automation.click': 'Click browser element',
  'browser.automation.tap': 'Tap browser surface',
  'browser.automation.type': 'Type into browser',
  'browser.automation.press': 'Press browser key',
  'browser.automation.scroll': 'Scroll browser surface',
  'browser.automation.hover': 'Hover browser element',
  'browser.automation.focus': 'Focus browser element',
  'browser.automation.select': 'Select browser option',
  'browser.automation.setValue': 'Set browser field value',
  'browser.recording.start': 'Start browser recording',
  'browser.recording.stop': 'Stop browser recording',
  'browser.recording.cancel': 'Cancel browser recording',
  'browser.recording.status': 'Get browser recording status',
  'browser.recording.listForView': 'List browser recordings for view',
  'browser.recording.discard': 'Discard browser recording',
  'browser.recording.cleanupExpired': 'Clean up expired browser recordings',
  'browser.recording.attachToComposer': 'Attach browser recording to composer',
});

export const BROWSER_RUNTIME_ACTION_DESCRIPTIONS: Readonly<Partial<Record<RuntimeActionIdV1, string>>> = Object.freeze({
  'browser.session.create': 'Create a managed browser session for the current workspace.',
  'browser.session.close': 'Close a managed browser session and release its resources.',
  'browser.view.open': 'Open a browser view inside an existing browser session.',
  'browser.view.close': 'Close a browser view and detach it from its session.',
  'browser.view.focus': 'Bring a browser view to the foreground of its session.',
  'browser.target.set': 'Point a browser view at a launch target or URL.',
  'browser.navigate': 'Navigate a browser view to a URL.',
  'browser.reload': 'Reload the current page in a browser view.',
  'browser.goBack': 'Navigate back in a browser view history.',
  'browser.goForward': 'Navigate forward in a browser view history.',
  'browser.stop': 'Stop the in-progress page load in a browser view.',
  'browser.context.capturePage': 'Capture the current browser page as shareable context.',
  'browser.context.captureScreenshot': 'Capture a screenshot of the browser view as context.',
  'browser.context.captureSelectedElement': 'Capture the selected browser element as context.',
  'browser.context.captureNetworkSummary': 'Capture a redacted summary of recent browser network activity.',
  'browser.context.captureConsoleSummary': 'Capture a redacted summary of recent browser console output.',
  'browser.context.annotation.start': 'Start an in-page browser annotation session.',
  'browser.context.annotation.cancel': 'Cancel the active browser annotation session.',
  'browser.context.annotation.captureRegion': 'Capture a cropped region for the active browser annotation.',
  'browser.context.annotation.captureElement': 'Capture a selected element for the active browser annotation.',
  'browser.context.annotation.attachComment': 'Attach a comment to the active browser annotation.',
  'browser.context.annotation.attachStroke': 'Attach a freehand stroke to the active browser annotation.',
  'browser.context.annotation.attachStyleIntent': 'Set the drawing style for the active browser annotation.',
  'browser.automation.status': 'Read the current browser automation status.',
  'browser.automation.snapshot': 'Capture an automation snapshot of the browser view.',
  'browser.automation.semanticSnapshot': 'Capture a semantic accessibility snapshot of the browser view.',
  'browser.automation.queryElements': 'Query elements in the browser view by selector or role.',
  'browser.automation.waitFor': 'Wait for a browser condition before continuing automation.',
  'browser.automation.timeline.get': 'Read the recorded browser automation action timeline.',
  'browser.automation.cancelActive': 'Cancel the active browser automation operation.',
  'browser.automation.navigate': 'Automate navigation of the browser view to a URL.',
  'browser.automation.reload': 'Automate reloading the current browser page.',
  'browser.automation.goBack': 'Automate navigating back in the browser view.',
  'browser.automation.goForward': 'Automate navigating forward in the browser view.',
  'browser.automation.click': 'Automate clicking a browser element.',
  'browser.automation.tap': 'Automate tapping the browser surface.',
  'browser.automation.type': 'Automate typing text into the browser view.',
  'browser.automation.press': 'Automate pressing a key in the browser view.',
  'browser.automation.scroll': 'Automate scrolling the browser surface.',
  'browser.automation.hover': 'Automate hovering over a browser element.',
  'browser.automation.focus': 'Automate focusing a browser element.',
  'browser.automation.select': 'Automate selecting an option in the browser view.',
  'browser.automation.setValue': 'Automate setting the value of a browser field.',
  'browser.recording.attachToComposer': 'Attach a captured browser recording to the message composer.',
});

export const BROWSER_COMMAND_KINDS_BY_RUNTIME_ACTION: Readonly<Partial<Record<RuntimeActionIdV1, string>>> = Object.freeze({
  'browser.session.create': 'createSession',
  'browser.session.close': 'closeSession',
  'browser.view.open': 'openView',
  'browser.view.close': 'closeView',
  'browser.view.focus': 'focusView',
  'browser.target.set': 'setTarget',
  'browser.navigate': 'navigate',
  'browser.reload': 'reload',
  'browser.goBack': 'goBack',
  'browser.goForward': 'goForward',
  'browser.stop': 'stop',
});

const BROWSER_AUTOMATION_KINDS_BY_RUNTIME_ACTION: Readonly<Partial<Record<RuntimeActionIdV1, string>>> = Object.freeze({
  'browser.automation.status': 'getStatus',
  'browser.automation.snapshot': 'snapshot',
  'browser.automation.semanticSnapshot': 'semanticSnapshot',
  'browser.automation.queryElements': 'queryElements',
  'browser.automation.waitFor': 'waitFor',
  'browser.automation.timeline.get': 'getActionTimeline',
  'browser.automation.navigate': 'navigate',
  'browser.automation.reload': 'reload',
  'browser.automation.goBack': 'goBack',
  'browser.automation.goForward': 'goForward',
  'browser.automation.click': 'click',
  'browser.automation.tap': 'tap',
  'browser.automation.type': 'type',
  'browser.automation.press': 'press',
  'browser.automation.scroll': 'scroll',
  'browser.automation.hover': 'hover',
  'browser.automation.focus': 'focus',
  'browser.automation.select': 'select',
  'browser.automation.setValue': 'setValue',
});

function refineAutomationActionSchema(actionId: RuntimeActionIdV1): z.ZodTypeAny {
  const expected = BROWSER_AUTOMATION_KINDS_BY_RUNTIME_ACTION[actionId];
  if (!expected) return RuntimeBrowserViewInputSchema;
  return refineKindSchema(BrowserAutomationActionRequestV1Schema, 'actionKind', expected, 'Browser automation actionKind');
}

function browserRuntimeActionInputSchema(actionId: RuntimeActionIdV1): z.ZodTypeAny | null {
  const browserCommandKind = BROWSER_COMMAND_KINDS_BY_RUNTIME_ACTION[actionId];
  if (browserCommandKind) {
    return refineKindSchema(BrowserCommandV1Schema, 'kind', browserCommandKind, 'Browser command kind');
  }

  if (actionId === 'browser.diagnostics.eval') return BrowserDiagnosticsEvalRequestV1Schema;
  if (actionId === 'browser.diagnostics.getProperties') return BrowserDiagnosticsGetPropertiesRequestV1Schema;
  if (actionId === 'browser.diagnostics.releaseObjectGroup') return BrowserDiagnosticsReleaseObjectGroupRequestV1Schema;
  if (actionId === 'browser.diagnostics.elementPicker.start') {
    return refineKindSchema(BrowserDiagnosticsElementPickerRequestV1Schema, 'action', 'start', 'Browser element-picker action');
  }
  if (actionId === 'browser.diagnostics.elementPicker.cancel') {
    return refineKindSchema(BrowserDiagnosticsElementPickerRequestV1Schema, 'action', 'cancel', 'Browser element-picker action');
  }
  if (actionId.startsWith('browser.diagnostics.')) return RuntimeBrowserViewInputSchema;
  if (actionId.startsWith('browser.context.')) return RuntimeBrowserContextActionInputSchema;
  if (actionId.startsWith('browser.automation.')) return refineAutomationActionSchema(actionId);
  if (actionId === 'browser.recording.start') return DaemonBrowserRecordingStartInputV1Schema;
  if (actionId === 'browser.recording.stop') return DaemonBrowserRecordingStopInputV1Schema;
  if (actionId === 'browser.recording.cancel' || actionId === 'browser.recording.discard') {
    return DaemonBrowserRecordingCancelInputV1Schema;
  }
  if (actionId === 'browser.recording.status') return DaemonBrowserRecordingStatusInputV1Schema;
  if (actionId === 'browser.recording.listForView') return DaemonBrowserRecordingListInputV1Schema;
  if (actionId === 'browser.recording.cleanupExpired') return DaemonBrowserRecordingCleanupInputV1Schema;
  if (actionId === 'browser.recording.attachToComposer') return RuntimeBrowserRecordingAttachInputSchema;
  return null;
}

function browserRuntimeActionOutputSchema(actionId: RuntimeActionIdV1): z.ZodTypeAny | null {
  if (BROWSER_COMMAND_KINDS_BY_RUNTIME_ACTION[actionId]) return BrowserCommandDispatchResultV1Schema;
  if (actionId.startsWith('browser.diagnostics.snapshot')) return BrowserDiagnosticsSnapshotV1Schema;
  if (actionId === 'browser.diagnostics.eval') return BrowserDiagnosticsEvalResultV1Schema;
  if (actionId === 'browser.diagnostics.getProperties') return BrowserDiagnosticsGetPropertiesResultV1Schema;
  if (actionId === 'browser.diagnostics.releaseObjectGroup') return BrowserDiagnosticsReleaseObjectGroupResultV1Schema;
  if (actionId.startsWith('browser.diagnostics.elementPicker.')) return BrowserDiagnosticsElementPickerResultV1Schema;
  if (actionId.startsWith('browser.context.attach')) return BrowserContextAttachmentV1Schema;
  if (actionId.startsWith('browser.context.')) return BrowserContextRouteResultV1Schema;
  if (actionId === 'browser.automation.timeline.get') return BrowserAutomationTimelineV1Schema;
  if (actionId.startsWith('browser.automation.')) return BrowserAutomationActionResultV1Schema;
  if (actionId === 'browser.recording.start') return DaemonBrowserRecordingStartResultV1Schema;
  if (actionId === 'browser.recording.stop') return DaemonBrowserRecordingStopResultV1Schema;
  if (actionId === 'browser.recording.cancel' || actionId === 'browser.recording.discard') return DaemonBrowserRecordingTerminalResultV1Schema;
  if (actionId === 'browser.recording.status') return z.unknown();
  if (actionId === 'browser.recording.listForView') return z.array(BrowserEvidenceArtifactV1Schema).or(z.unknown());
  if (actionId === 'browser.recording.cleanupExpired') return DaemonBrowserRecordingCleanupResultV1Schema;
  return null;
}

export const BROWSER_RUNTIME_ACTION_SPEC_FAMILY = Object.freeze({
  titles: BROWSER_RUNTIME_ACTION_TITLES,
  descriptions: BROWSER_RUNTIME_ACTION_DESCRIPTIONS,
  inputSchemaForAction: browserRuntimeActionInputSchema,
  outputSchemaForAction: browserRuntimeActionOutputSchema,
} satisfies RuntimeActionSpecFamily);
