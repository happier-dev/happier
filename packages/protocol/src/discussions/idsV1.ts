
/** Action identity leaf: schema modules and the registry share these constants. */
/**
 * User-invocable Home Discussion intents. People (UI/CLI) and
 * supported Agents reach the same durable discussions through these ids; there
 * is no Agent-specific discussion tool and no second discussion vocabulary.
 *
 * Automatic viewport cursor synchronization, draft synchronization, presence and
 * internal attention loading stay owner-native operations and deliberately have
 * no id here: an automatic foreground read observation must not become a tool
 * that lets an Agent mark a human's messages read.
 *
 * This leaf carries only the ids so the canonical Action id registry can import
 * it without pulling the discussion content schemas into that module graph.
 */
export const DISCUSSION_ACTION_IDS_V1 = [
  'discussion.list',
  'discussion.get',
  'discussion.settings.get',
  'discussion.settings.set',
  'discussion.read',
  'discussion.attachment.read',
  'discussion.create',
  'discussion.second_opinion.start',
  'discussion.post',
  'discussion.reply',
  'discussion.pass',
  'discussion.rename',
  'discussion.archive',
  'discussion.restore',
  'discussion.read_state.set',
  'discussion.participants.list',
  'discussion.candidates.list',
  'discussion.invite',
  'discussion.participant.remove',
  'discussion.participant.policy.set',
  'discussion.leave',
  'discussion.owner.transfer',
  'discussion.access.grants.list',
  'discussion.access.grants.set',
  'discussion.access.grants.remove',
] as const;
