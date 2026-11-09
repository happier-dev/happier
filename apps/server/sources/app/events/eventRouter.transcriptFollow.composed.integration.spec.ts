import { registerTranscriptFollowTimingTests } from './transcriptFollowTiming.composed.testkit';

registerTranscriptFollowTimingTests('sqlite');
// A 250ms finite HTTP RTT models the order of the historical remote-host
// clock/RTT brackets; it is a stress input, not a measured mac-host RTT.
registerTranscriptFollowTimingTests('sqlite', 250);
registerTranscriptFollowTimingTests('sqlite', 0, 'socket-flow-budget');
