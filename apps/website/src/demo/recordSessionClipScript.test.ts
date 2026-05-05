import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const websiteRoot = path.resolve(__dirname, '../..');
const scriptPath = path.join(websiteRoot, 'scripts', 'recordSessionClip.sh');

describe('recordSessionClip.sh', () => {
    it('rejects output names that are not safe basenames inside public/videos/demo/sessions', () => {
        const script = fs.readFileSync(scriptPath, 'utf8');

        expect(script).toContain('validate_output_name()');
        expect(script).toContain('resolve_output_path()');
        expect(script).toContain('^[A-Za-z0-9][A-Za-z0-9._-]*$');
        expect(script).toContain('[[ "$name" == "$(basename -- "$name")" ]]');
        expect(script).toContain('resolved_parent="${resolved_output%/*}"');
        expect(script).toContain('output path escapes target directory');
    });
});
