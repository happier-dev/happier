/**
 * One case-insensitive response-header read for every Triage source.
 *
 * HTTP header names are case-insensitive, providers spell the same header several
 * ways across their own documentation, and a source that reaches a header record
 * by exact key silently reads nothing. Private copies of this four-line rule had
 * drifted into two *opposite* argument contracts — some required the caller to
 * pre-lowercase the wanted name, others lowercased it themselves — and into three
 * different absent values. That is a live footgun in one corridor rather than a
 * style difference, so the sources read headers through here.
 *
 * The contract is the safe one: the wanted name is lowercased for the caller, the
 * value is trimmed, and a header present but empty reads as absent, because a
 * provider that sends `Retry-After: ` has stated no hint. That last rule is load
 * bearing — an empty `Link:` read as *present* makes a walk report a finished
 * collection on evidence the provider never gave.
 *
 * `scm-forge-adapter` keeps its own two reads. That package declares no
 * dependencies and peers only the plugin SDK, so reaching this owner would add a
 * dependency edge its boundary deliberately refuses; both of its copies already
 * match this contract, so neither carries the drift.
 */

/**
 * Reads one header from a plain header record, case-insensitively.
 *
 * `name` may be given in any case. Returns `null` when the header is absent or
 * carries no non-whitespace value.
 */
export function readTriageResponseHeaderV1(
    headers: Readonly<Record<string, string>>,
    name: string,
): string | null {
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() !== wanted || typeof value !== 'string') continue;
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    return null;
}
