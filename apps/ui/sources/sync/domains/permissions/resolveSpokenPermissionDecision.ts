const permissionTarget = String.raw`(?:it|that|(?:the|this|that) command)`;
const grant = String.raw`(?:allow|approve)(?: ${permissionTarget})?`;
const refuse = String.raw`(?:deny|decline|reject)(?: ${permissionTarget})?`;
const negatedGrant = String.raw`(?:don't|do not)(?: (?:${grant}|(?:do|run)(?: ${permissionTarget})?))?`;

// Both polarities consume the same request reference grammar. Unrecognized or
// contradictory trailing instructions remain an undecided answer.
const affirmative = new RegExp(String.raw`^(?:(?:yes|yeah|yep|okay|ok)(?: please)?(?: (?:${grant}|go ahead|do it))?|(?:please )?(?:${grant}|go ahead|do it))(?: please)?$`, 'u');
// R143 ASR ended an explicit refusal with an unfinished 'I'; complete
// trailing instructions still have to match the refusal grammar.
const negative = new RegExp(String.raw`^(?:(?:no|nope)(?: thanks| thank you| but)?(?: (?:${refuse}|${negatedGrant}))?|(?:please )?(?:${refuse}|${negatedGrant}))(?: please)?(?: i)?$`, 'u');

function normalize(text: string): string {
    return text.trim().toLocaleLowerCase().replace(/[’‘]/gu, "'")
        .replace(/[,.!?。！？]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

/** Interpret a spoken answer; the permission owner still selects an offered option. */
export function resolveSpokenPermissionDecision(
    text: string,
    labels: Readonly<{ yes: string; no: string }>,
): 'approved' | 'denied' | null {
    const answer = normalize(text);
    if (!answer) return null;
    if (answer === normalize(labels.yes) || affirmative.test(answer)) return 'approved';
    // Preserve the observed unfinished "NO BUT", but never "NO BUT ALLOW IT".
    if (answer === normalize(labels.no) || negative.test(answer)) return 'denied';
    return null;
}
