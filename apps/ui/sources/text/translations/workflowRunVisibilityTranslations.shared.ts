

export type VisibilityCopy = Readonly<{ title: string; chooseTeam: string; loadFailed: string; machines: string; transcripts: string; requiredSessionsEditable: string; visibleTo: (params: { team: string }) => string }>;


export const workflowRunVisibilityTranslationsEnglish: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', VisibilityCopy>, "en"> = { en: { title: "Visibility", chooseTeam: "Choose a Team", loadFailed: "Could not check who can see this run", machines: "Runs on your machines", transcripts: "Team members can view the step conversations.", requiredSessionsEditable: "This Team's sessions are editable by its members", visibleTo: ({ team }) => "Visible to " + team } };