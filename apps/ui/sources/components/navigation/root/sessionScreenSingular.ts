/**
 * The root stack keeps one Session view screen: opening another Session (or another view of one) moves that
 * screen's route instead of stacking a second one, so the screen and its retained Session views stay mounted.
 */
export const SESSION_SCREEN_SINGULAR = 'session';
export const sessionScreenSingular = (): string => SESSION_SCREEN_SINGULAR;
