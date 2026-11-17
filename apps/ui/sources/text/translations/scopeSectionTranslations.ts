// Copy for the "Skills and MCP servers" section a machine page and a project page share (P8 U8.6, lab xs-M/Mp/P/Pp).
// Mounted under `capabilities.scopeSection`. Templates use {name} placeholders; `foundOne` is the singular line.

type Params = Readonly<Record<string, string | number>>;
type Template = (params: Params) => string;

type Words = Readonly<{
  title: string;
  descMachine: string;
  descProject: string;
  descProjectTeam: string;
  skills: string;
  mcp: string;
  allSkills: string;
  allMcp: string;
  foundOne: string;
  foundMany: string;
  foundLink: string;
  onFor: string;
  notFor: string;
  onOn: string;
  notOn: string;
  onIn: string;
  offIn: string;
  onForPlace: string;
  offForPlace: string;
  emptySkills: string;
  addSkill: string;
  emptyMcp: string;
  addMcp: string;
  loadFailed: string;
  whenRunning: string;
  turnedOn: string;
  turnedOff: string;
  migrationNote: string;
  dismiss: string;
}>;

const fill =
  (template: string): Template =>
  (params) =>
    template.replace(/\{(\w+)\}/g, (_, key: string) =>
      String(params[key] ?? ''),
    );

export function copy(words: Words) {
  const foundOne = fill(words.foundOne);
  const foundMany = fill(words.foundMany);
  return {
    title: words.title,
    descMachine: fill(words.descMachine) as (
      params: Readonly<{ machine: string }>,
    ) => string,
    descProject: fill(words.descProject) as (
      params: Readonly<{ project: string }>,
    ) => string,
    descProjectTeam: fill(words.descProjectTeam) as (
      params: Readonly<{ project: string; team: string }>,
    ) => string,
    skills: words.skills,
    mcp: words.mcp,
    allSkills: fill(words.allSkills) as (
      params: Readonly<{ count: number }>,
    ) => string,
    allMcp: fill(words.allMcp) as (
      params: Readonly<{ count: number }>,
    ) => string,
    foundMore: (params: Readonly<{ count: number; machine: string }>) =>
      (params.count === 1 ? foundOne : foundMany)(params),
    foundLink: words.foundLink,
    onFor: fill(words.onFor) as (
      params: Readonly<{ agents: string }>,
    ) => string,
    notFor: fill(words.notFor) as (
      params: Readonly<{ agents: string }>,
    ) => string,
    onOn: fill(words.onOn) as (
      params: Readonly<{ machines: string }>,
    ) => string,
    notOn: fill(words.notOn) as (
      params: Readonly<{ machines: string }>,
    ) => string,
    onIn: fill(words.onIn) as (params: Readonly<{ place: string }>) => string,
    offIn: fill(words.offIn) as (params: Readonly<{ place: string }>) => string,
    onForPlace: fill(words.onForPlace) as (
      params: Readonly<{ place: string }>,
    ) => string,
    offForPlace: fill(words.offForPlace) as (
      params: Readonly<{ place: string }>,
    ) => string,
    emptySkills: words.emptySkills,
    addSkill: words.addSkill,
    emptyMcp: words.emptyMcp,
    addMcp: words.addMcp,
    loadFailed: words.loadFailed,
    whenRunning: fill(words.whenRunning) as (
      params: Readonly<{ machine: string }>,
    ) => string,
    turnedOn: fill(words.turnedOn) as (
      params: Readonly<{ name: string; place: string }>,
    ) => string,
    turnedOff: fill(words.turnedOff) as (
      params: Readonly<{ name: string; place: string }>,
    ) => string,
    migrationNote: fill(words.migrationNote) as (
      params: Readonly<{ names: string }>,
    ) => string,
    dismiss: words.dismiss,
  };
}

export const scopeSectionTranslations = {
  en: copy({
    title: 'Skills and MCP servers',
    descMachine:
      'What sessions on {machine} get. A switch here sets a rule for {machine} only; agent exceptions still hold.',
    descProject:
      'Your sessions in {project} get these on every machine. A switch here sets a rule for {project} only; agent exceptions still hold.',
    descProjectTeam:
      'Your sessions in {project} get these on every machine. A switch here sets a rule for {project} only; {team}’s sessions follow their own.',
    skills: 'Skills',
    mcp: 'MCP servers',
    allSkills: 'All {count} skills',
    allMcp: 'All {count} MCP servers',
    foundOne: '1 more skill lives only on {machine}.',
    foundMany: '{count} more skills live only on {machine}.',
    foundLink: 'Found on your machines',
    onFor: 'On for {agents}',
    notFor: 'not {agents}',
    onOn: 'On on {machines}',
    notOn: 'not {machines}',
    onIn: 'On in {place}',
    offIn: 'Off in {place}',
    onForPlace: 'On for {place}',
    offForPlace: 'Off for {place}',
    emptySkills: 'No skills yet',
    addSkill: 'Add a skill',
    emptyMcp: 'No MCP servers yet',
    addMcp: 'Add a server',
    loadFailed: 'Couldn’t load',
    whenRunning: 'Listed once {machine} is running',
    turnedOn: '{name} is on for {place}',
    turnedOff: '{name} is off for {place}',
    migrationNote: '{names} moved here from your older project settings.',
    dismiss: 'Dismiss',
  }),
} as const;
