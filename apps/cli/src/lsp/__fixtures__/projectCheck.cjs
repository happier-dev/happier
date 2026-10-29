const fs = require('node:fs');
const path = require('node:path');
const [scenario, started] = process.argv.slice(2);
const diagnostics = () => {
    process.stdout.write(`${path.join(process.cwd(), 'src/a(b).ts')}(2,3): error TS2322: Wrong type\n  More detail\nerror TS18003: No inputs were found\n`);
    process.exitCode = 2;
};
if (scenario === 'wait') {
    fs.writeFileSync(started, 'ready');
    setInterval(() => {}, 1000);
} else if (scenario === 'diagnostics') {
    diagnostics();
} else if (scenario === 'gated-diagnostics') {
    const watcher = fs.watch(path.dirname(started), () => {
        if (!fs.existsSync(`${started}.release`)) return;
        watcher.close();
        diagnostics();
    });
    fs.writeFileSync(started, 'ready');
} else if (scenario === 'large') {
    for (let index = 0; index < Number(process.argv[4] || 90_000); index++) fs.writeSync(1, `src/large.ts(${index + 1},1): error TS2322: ${'x'.repeat(90)}\n`);
    process.exitCode = 2;
} else if (scenario === 'outside') {
    process.stdout.write('../outside.ts(1,1): error TS2322: Outside root\n');
    process.exitCode = 2;
} else if (scenario === 'unparseable') {
    process.stdout.write('Invalid checker output\n');
} else if (scenario === 'empty-failure') {
    process.exitCode = 2;
}
