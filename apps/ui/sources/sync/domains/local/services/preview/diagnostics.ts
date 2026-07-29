import {
    LocalServicePreviewDiagnosticV1Schema,
    type LocalServicePreviewDiagnosticV1,
} from '@happier-dev/protocol';

export function readLocalServicePreviewDiagnostics(
    value: readonly unknown[],
): readonly LocalServicePreviewDiagnosticV1[] {
    return value
        .map((entry): LocalServicePreviewDiagnosticV1 | null => {
            const parsed = LocalServicePreviewDiagnosticV1Schema.safeParse(entry);
            return parsed.success ? parsed.data : null;
        })
        .filter((entry): entry is LocalServicePreviewDiagnosticV1 => Boolean(entry));
}
