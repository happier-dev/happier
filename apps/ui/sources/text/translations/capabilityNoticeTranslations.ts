// Transcript capability notice copy (P1 U7): one quiet line when an MCP server or skill was left out of a Session.
// Mounted under `capabilities.notice`; the reason words cover the producer's known codes, anything else is shown as stored.

type Name = Readonly<{ name: string }>;
type Words = readonly [
  mcpTitle: string,
  skillTitle: string,
  missing: string,
  signIn: string,
  signInMismatch: string,
  bridge: string,
  skillLaunch: string,
  openMcp: string,
  openSkills: string,
  contentUnreadable: string,
  signInUnavailable: string,
];

export function copy(words: Words) {
  const named = (text: string) => ({ name }: Name) => text.replace('{name}', name);
  return {
    couldntStart: named(words[0]),
    couldntLoad: named(words[1]),
    missing: ({ key }: Readonly<{ key: string }>) => words[2].replace('{key}', key),
    signIn: words[3],
    signInMismatch: words[4],
    bridge: words[5],
    skillLaunch: words[6],
    openMcp: words[7],
    openSkills: words[8],
    contentUnreadable: words[9],
    signInUnavailable: words[10],
  };
}

export const capabilityNoticeTranslations = {
  en: copy(['{name} couldn’t start', '{name} couldn’t load', 'missing {key}', 'needs sign-in', 'sign-in is for another address',
    'remote bridge unavailable', 'this agent can’t take skills this way', 'MCP servers', 'Skills', 'its files couldn’t be read', 'its sign-in couldn’t be passed to this session']),
} as const;
