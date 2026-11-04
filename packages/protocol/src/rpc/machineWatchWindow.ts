/**
 * Existing Processes observation/history retention and ownership refresh duration. Parked Machine RPCs have no
 * expiry: their operation lifetime follows the caller and remote reply, with transport-owned
 * connection/setup budgets. This value does not schedule unchanged watch answers.
 */
export const MACHINE_WATCH_WINDOW_MS = 25_000;
