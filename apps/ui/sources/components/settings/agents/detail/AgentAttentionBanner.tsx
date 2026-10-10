import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';

/**
 * The one tinted notice an agent page shows when something blocks using the agent. It names the
 * problem and carries the next action; healthy agents never render it. What its computer is
 * doing (offline, locked, still listing) is said in "Setup and status", beside the machine chip.
 */
export const AgentAttentionBanner = AttentionBanner;
