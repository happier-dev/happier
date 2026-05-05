import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const websiteRoot = path.resolve(__dirname, '../..');
const scriptPath = path.join(websiteRoot, 'scripts', 'recordCastInteractive.sh');

describe('recordCastInteractive.sh', () => {
    it('passes prompt and path data into expect via argv instead of raw heredoc interpolation', () => {
        const script = fs.readFileSync(scriptPath, 'utf8');

        expect(script).toContain("<<'EXPECT'");
        expect(script).toContain('set projectDir [lindex $argv 0]');
        expect(script).toContain('set providerBin [lindex $argv 1]');
        expect(script).toContain('set prompt [lindex $argv 2]');
        expect(script).toContain('set providerArgs [lrange $argv 3 end]');
        expect(script).toContain('send -h -- $prompt');
        expect(script).toContain('printf -v DRIVER_COMMAND_STR "%q "');
        expect(script).not.toContain('cd $PROJECT_DIR');
        expect(script).not.toContain('spawn $PROVIDER_BIN $PROVIDER_ARGS');
        expect(script).not.toContain('send -h -- "$PROMPT"');
    });

    it('sanitizes trimmed casts before leaving them in the public tree', () => {
        const script = fs.readFileSync(scriptPath, 'utf8');

        expect(script).toContain('/usr/bin/python3 "$SCRIPT_DIR/trimCast.py" "$OUT"');
        expect(script).toContain('/usr/bin/python3 "$SCRIPT_DIR/sanitizeCast.py" "$OUT"');
        expect(script.indexOf('trimCast.py')).toBeLessThan(script.indexOf('sanitizeCast.py'));
    });

    it('rejects output names that are not safe basenames inside public/casts', () => {
        const script = fs.readFileSync(scriptPath, 'utf8');

        expect(script).toContain('validate_output_name()');
        expect(script).toContain('resolve_output_path()');
        expect(script).toContain('^[A-Za-z0-9][A-Za-z0-9._-]*$');
        expect(script).toContain('[[ "$name" == "$(basename -- "$name")" ]]');
        expect(script).toContain('resolved_parent="${resolved_output%/*}"');
        expect(script).toContain('output path escapes target directory');
    });
});
