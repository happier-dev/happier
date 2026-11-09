import type { InteractionTransientQuestionV1 } from '@happier-dev/protocol/plugins/interactions/transientV1';

/** Native and needs-you questions share the incumbent permission form projection. */
export function toStructuredQuestionPermissionInput(request: Readonly<{
    title?: string;
    questions: readonly InteractionTransientQuestionV1[];
}>): unknown {
    return Object.freeze({
        ...(request.title ? { title: request.title } : {}),
        questions: request.questions.map((question) => Object.freeze({
            id: question.id,
            question: question.prompt,
            required: question.required,
            ...(question.allowNote === undefined ? {} : { allowNote: question.allowNote }),
            ...(question.type === 'text'
                ? { selection: 'text' as const,
                    ...(question.initialValue === undefined ? {} : { presentation: { initialValue: question.initialValue } }) }
                : { selection: question.type === 'singleChoice' ? 'single' as const : 'multiple' as const,
                    options: question.choices.map((choice) => Object.freeze({
                        id: choice.id, label: choice.label,
                        ...(choice.description ? { description: choice.description } : {}),
                    })),
                    ...(question.allowCustom ? { allowCustom: true } : {}),
                    ...(question.minSelections === undefined ? {} : { minSelections: question.minSelections }),
                    ...(question.maxSelections === undefined ? {} : { maxSelections: question.maxSelections }),
                }),
        })),
    });
}
