/** Closed canvas vocabulary, independent from its drag/drop schema graph. */
export const SESSION_CANVAS_ACTION_IDS = [
  'session.canvas.tabs.list', 'session.canvas.tabs.open', 'session.canvas.tabs.activate',
  'session.canvas.tabs.close', 'session.canvas.tabs.move', 'session.canvas.tabs.reorder', 'session.canvas.tabs.pin',
] as const;
export type SessionCanvasActionId = typeof SESSION_CANVAS_ACTION_IDS[number];
