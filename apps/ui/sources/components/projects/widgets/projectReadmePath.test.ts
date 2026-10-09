import { expect, it } from 'vitest';
import { readProjectReadmePath } from './projectReadmePath';

it('opens the actual root README file and never treats a README directory or nested file as the document', () => {
    expect(readProjectReadmePath([
        { name: 'README.md', type: 'directory' },
        { name: 'readme.MD', type: 'file' },
        { name: 'docs/README.md', type: 'file' },
    ])).toBe('readme.MD');
    expect(readProjectReadmePath([{ name: 'package.json', type: 'file' }])).toBeNull();
});
