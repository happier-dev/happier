const MESSAGES_PLACEHOLDER = '{{MESSAGES}}';

export function applySendToSessionTemplate(input: {
    template: string;
    formattedMessages: string;
    selectedCount: number;
    sourceSessionName: string | null;
}): string {
    const template = input.template;
    if (!template.trim()) return input.formattedMessages;

    const replacements: Readonly<Record<string, string>> = {
        [MESSAGES_PLACEHOLDER]: input.formattedMessages,
        '{{SELECTED_COUNT}}': String(input.selectedCount),
        '{{SOURCE_SESSION_NAME}}': input.sourceSessionName ?? '',
    };

    let rendered = template;
    for (const [placeholder, value] of Object.entries(replacements)) {
        rendered = rendered.split(placeholder).join(value);
    }

    if (template.includes(MESSAGES_PLACEHOLDER)) return rendered;
    return `${template.trimEnd()}\n\n${input.formattedMessages}`;
}
