import { describe, expect, it } from 'vitest';

import { findTranslationProblems } from './validateTranslationMap';
import type { LocaleLiteral } from './localeLiterals';

/**
 * The interpolation check exists to catch a `${` the translator INVENTED, because that either
 * breaks the build or silently swallows the rest of the sentence. A handful of English strings
 * document the template syntax to the user and contain a literal `${VAR}` of their own — those the
 * translation has to keep, and both the shipped Spanish and French do
 * ("Valor o ${ENV_VAR}", "Valeur ou ${ENV_VAR}").
 *
 * A literal reaching this check can never be a real interpolation hole: a template literal is split
 * into fragments around its holes before it gets here, so a surviving `${` is inert text.
 */
function literal(key: string, text: string): LocaleLiteral {
    return { key, kind: 'string', delim: "'", start: 0, end: text.length, text, raw: text };
}

describe('findTranslationProblems', () => {
    it('flags an interpolation the translation introduced', () => {
        const { problems } = findTranslationProblems([literal('a#0', 'Store a value')], {
            'a#0': 'Speichere einen ${wert}',
        });
        expect(problems.map((p) => p.kind)).toContain('interpolation-introduced');
    });

    it('allows a literal ${VAR} the English already documents', () => {
        const literals = [
            literal('a#0', 'Store a value (supports ${VAR} templates)'),
            literal('b#0', 'Value or ${ENV_VAR}'),
        ];
        const { problems } = findTranslationProblems(literals, {
            'a#0': 'Einen Wert speichern (unterstützt ${VAR}-Templates)',
            'b#0': 'Wert oder ${ENV_VAR}',
        });
        expect(problems).toEqual([]);
    });

    it('still flags a translation that mangles the documented placeholder name', () => {
        const { problems } = findTranslationProblems([literal('a#0', 'Value or ${ENV_VAR}')], {
            'a#0': 'Wert oder ${UMGEBUNGSVARIABLE}',
        });
        expect(problems.map((p) => p.kind)).toContain('interpolation-renamed');
    });
});
