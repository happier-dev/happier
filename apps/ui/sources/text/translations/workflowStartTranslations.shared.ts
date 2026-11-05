import { workflowRunRoleTranslationsEnglish as workflowRunRoleTranslations } from './workflowRunRoleTranslations.shared';


import { workflowRunCompositionTranslationsEnglish as workflowRunCompositionTranslations } from './workflowRunCompositionTranslations.shared';



export type Copy = typeof en;



export const en = {
    ...workflowRunRoleTranslations.en,
    ...workflowRunCompositionTranslations.en,
    shortcutStarts: 'starts',
    runPattern: 'Run…', runPatternTitle: 'Run a pattern', anotherRound: 'Another round',
    answerCount: ({ count }: { count: number }) => count === 1 ? '1 answer' : `${count} answers`,
    participantTitle: 'Choose who takes part', participantSearch: 'Find a session or model', participantSession: 'Each answers with its own setup', participantModel: ({ agent, machine }: { agent: string; machine: string }) => `New ${agent} session on ${machine}`, participantDone: 'Done', choicesFailed: 'Couldn’t load the choices',
    workflow: 'Workflow', inputs: 'Inputs', start: 'Start', starting: 'Starting…', stillStarting: 'Still starting…',
    retry: { action: 'Try again', start: 'Couldn’t confirm this Run started. Try again re-sends this exact request; it won’t start twice.', runAgain: 'Couldn’t confirm Run again started. Try again re-sends this exact request; it won’t start twice.', anotherRound: 'Couldn’t confirm Another round started. Try again re-sends this exact request; it won’t start twice.' },
    needed: ({ count }: { count: number }) => `Inputs · ${count} needed`,
    neededNamed: ({ name }: { name: string }) => `Inputs · ${name} needed`,
    addToStart: ({ name }: { name: string }) => `${name} is needed to start`,
    required: 'Required to start', preview: 'What it will do', unsaved: 'Includes unsaved edits',
    remove: 'Return to a plain session', search: 'Find a pattern', builtin: 'Built-in', library: 'Your library',
    noInputs: 'No inputs needed', needsSession: 'Needs a session', asksFor: ({ names }: { names: string }) => `Asks for ${names}`,
    optional: 'Optional — left empty', defaultValue: ({ value }: { value: string }) => `Default: ${value}`,
    capture: {
        title: 'Save as pattern', subtitle: ({ title }: { title: string }) => `From ${title}`,
        chooseTitle: 'Build it from', chooseDescription: 'Choose the question and the answers that make up the exchange.',
        chosenCount: ({ count }: { count: number }) => count === 1 ? '1 chosen' : `${count} chosen`,
        emptyTitle: 'Nothing to save yet', emptyBody: 'Once people and agents have talked here, choose the messages to save as a pattern.',
        reviewSteps: 'Review steps', openInEditor: 'Open in editor', name: 'Name',
        stepsTitle: 'Steps, from what happened here', changeMessages: 'Change messages', building: 'Building the steps…',
        failedTitle: 'Couldn’t build the steps',
        needsReview: ({ count }: { count: number }) => count === 1 ? '1 message needs a choice before it opens in the editor' : `${count} messages need a choice before they open in the editor`,
        question: 'Question', context: ({ number }: { number: number }) => `Context ${number}`,
        answers: ({ name }: { name: string }) => `${name} answers`, someoneAnswers: 'Someone answers', leftOut: 'Left out',
        uses: ({ steps }: { steps: string }) => `Uses ${steps}`, usesLabel: 'Uses', usedAs: 'Used as',
        roleInput: 'Input', roleStep: 'Step', roleExclude: 'Leave out',
        whoAnswers: 'Who answers', chooseParticipant: 'Choose…',
        askEachRun: 'Ask each time it runs', askEachRunOn: 'Run… asks for it', askEachRunOff: 'Kept as it is here',
        askedTitle: 'Asked each time you run it', askedNone: 'Nothing. It runs as saved.',
        agentFor: ({ number }: { number: number }) => `Who answers ${number}`,
        privacy: ({ count }: { count: number }) => `Opens unsaved in the editor. Once saved it’s private to you and links back to ${count === 1 ? 'this message' : `these ${count} messages`}.`,
        reasons: {
            unlinked_message: 'Not tied to an answer. Choose whether it’s an input, a step, or left out.',
            missing_dependency: 'Uses a message that isn’t included. Add it or change what this uses.',
            participant_required: 'Choose who answers this step.',
            no_steps: 'No answer is chosen yet. Add an agent’s answer to make a step.',
            unsupported_content: 'A pattern can’t reuse this kind of message. Leave it out.',
            ambiguous_workflow: 'These messages came from more than one run. Choose messages from one run.',
        },
    },
};


export const workflowStartTranslationsEnglish: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "en"> = { en };
