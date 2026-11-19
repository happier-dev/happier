import os, pathlib, subprocess, tempfile, time, sys
ROOT = pathlib.Path(__file__).resolve().parent
CP = os.environ.get('P03_SELFTEST_CP', str(ROOT / 'commit-partial.sh'))
REAL_GIT = subprocess.check_output(['which', 'git'], text=True).strip()
def case(kind):
    d = pathlib.Path(tempfile.mkdtemp(prefix='p03-replay-test.'))
    env = dict(os.environ, P03_COMMIT_KICK='true')
    def git(*args):
        return subprocess.check_output([REAL_GIT, *args], cwd=d, env=env, text=True).strip()
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Replay test'); git('config', 'user.email', 'replay@test.invalid')
    initial = ''.join(f'line {i}\n' for i in range(30))
    for f in ('a.txt', 'b.txt', 'c.txt', 'package.json'): (d/f).write_text(initial)
    git('add', '--', *(['a.txt', 'b.txt', 'package.json'] if kind == 'newfile' else ['a.txt', 'b.txt', 'c.txt', 'package.json'])); git('commit', '-qm', 'root')
    base = git('rev-parse', 'HEAD')
    (d/'a.txt').write_text(initial.replace('line 2\n', 'packet A\n'))
    (d/'c.txt').write_text(initial.replace('line 2\n', 'packet C\n'))
    pk = ['a.txt', 'c.txt']
    if kind == 'manifest':
        (d/'package.json').write_text(initial.replace('line 2\n', 'packet dep\n')); pk.append('package.json')
    (d/'packet.patch').write_text(git('diff', '-U3', 'HEAD', '--', *pk)+'\n')
    (d/'msg').write_text('test: packet A\n')
    idx = str(d/'private-b'); envb = dict(env, GIT_INDEX_FILE=idx)
    subprocess.check_call([REAL_GIT, 'read-tree', base], cwd=d, env=envb)
    target = 'b.txt' if kind in ('disjoint','newfile','cheapmiss','cas-loss','requeue') else 'package.json' if kind == 'manifest' else 'a.txt'
    content = initial.replace('line 20\n', 'packet B\n') if kind != 'conflict' else initial.replace('line 2\n', 'conflict B\n')
    blob = subprocess.check_output([REAL_GIT, 'hash-object', '-w', '--stdin'], input=content, cwd=d, text=True).strip()
    subprocess.check_call([REAL_GIT, 'update-index', '--cacheinfo', f'100644,{blob},{target}'], cwd=d, env=envb)
    tree = subprocess.check_output([REAL_GIT, 'write-tree'], cwd=d, env=envb, text=True).strip()
    b = git('commit-tree', tree, '-p', base, '-m', 'test: packet B')
    # Git process boundary: B wins exactly when A attempts its first CAS.
    bindir = d/'bin'; bindir.mkdir()
    shim = bindir/'git'
    shim.write_text(f'''#!/bin/bash
if [ '{kind}' = cas-loss ] && [ "$1" = update-ref ] && [ ! -e '{d}/moved' ]; then
 touch '{d}/moved'
 '{REAL_GIT}' update-ref refs/heads/main '{b}' '{base}' || exit 99
 # A must retain its gated snapshot, even when its working files change.
 echo 'later worktree edit' > '{d}/c.txt'
fi
exec '{REAL_GIT}' "$@"
'''); shim.chmod(0o755)
    # A second writer can land while the replayed candidate's full gate runs.
    later = git('commit-tree', tree, '-p', b, '-m', 'test: another wrapper landed')
    gate = d/'gate.sh'; gate.write_text(f'''#!/bin/bash
l=unlocked; flock -n "$(git rev-parse --git-common-dir)/p03-commit-partial.lock" true || l=locked
if [ '{kind}' != cas-loss ] && [ ! -e '{d}/moved' ]; then
 touch '{d}/moved'
 flock -x "$(git rev-parse --git-common-dir)/p03-commit-partial.lock" '{REAL_GIT}' update-ref refs/heads/main '{b}' '{base}' || exit 99
 echo 'later worktree edit' > '{d}/c.txt'
fi
[[ '{kind}' = cheapmiss || '{kind}' = requeue ]] && [ -n "${{P03_SCAN_CHEAP_ONLY:-}}" ] && [ ! -e '{d}/.missed' ] && {{ touch '{d}/.missed'; echo "$(git diff --name-only "$1" "$2" | sort | paste -sd,)|${{P03_GATE_PRIOR:+fast}}|$l|cheap-miss" >> '{d}/gates'; exit 3; }}
echo "$(git diff --name-only "$1" "$2" | sort | paste -sd,)|${{P03_GATE_PRIOR:+fast}}|$l" >> '{d}/gates'
if [ '{kind}' = requeue ] && [ -e '{d}/.missed' ] && [ -z "${{P03_SCAN_CHEAP_ONLY:-}}" ] && [ "$l" = unlocked ]; then
 flock -n "$(git rev-parse --git-common-dir)/p03-commit-partial.lock" '{REAL_GIT}' update-ref refs/heads/main '{later}' '{b}' || exit 99
fi
sleep 0.2
[ '{kind}' != refused ] || [ \"$(wc -l < '{d}/gates')\" -lt 2 ] || exit 10
''')
    fast = d/'fast.sh'; fast.write_text(f"#!/bin/bash\necho fast >> '{d}/fasts'\nsleep 0.2\nexit 2\n")
    env.update(PATH=str(bindir)+':'+env['PATH'], P03_COMMIT_GATE=str(gate), P03_COMMIT_FASTGATE=str(fast))
    selected = '-'
    if kind == 'newfile':
        (d/'wholefiles').write_text('c.txt\n'); selected=str(d/'wholefiles')
    start=time.monotonic()
    run=subprocess.run(['bash', CP, str(d/'msg'), selected, str(d/'packet.patch')], cwd=d, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    elapsed=time.monotonic()-start
    (d/'run.log').write_text(run.stdout)
    gates=(d/'gates').read_text().splitlines()
    print(f'{kind}: {elapsed:.3f}s rc={run.returncode} gates={gates} evidence={d}', flush=True)
    if kind in ('conflict', 'refused'):
        assert run.returncode != 0 and git('rev-parse','HEAD') == b, run.stdout
        assert ('replay conflict' if kind == 'conflict' else 'candidate refused') in run.stdout.lower(), run.stdout
    else:
        assert run.returncode == 0, run.stdout
        assert git('rev-parse','HEAD^') == (later if kind == 'requeue' else b)
        assert 'packet B' in git('show',f'HEAD:{target}'), 'replay lost B tree content'
        assert git('show','HEAD:a.txt').splitlines()[2] == 'packet A', 'replay lost A'
        if kind == 'intersect': assert git('show','HEAD:a.txt').splitlines()[20] == 'packet B', 'merged file lost B'
        if kind == 'manifest': assert git('show','HEAD:package.json').splitlines()[2] == 'packet dep', 'merged manifest lost A'
        assert git('show','HEAD:c.txt').splitlines()[2] == 'packet C', 'gated bytes changed'
        assert (d/'c.txt').read_text() == 'later worktree edit\n'
        pk = 'a.txt,c.txt' + (',package.json' if kind == 'manifest' else '')
        cheap = pk + '|fast|locked'
        fallback = [cheap + '|cheap-miss', pk + '|fast|unlocked']
        full = {
            'manifest': [pk + '||unlocked'],
            'cheapmiss': fallback,
            'cas-loss': [pk + '||unlocked'],
            'requeue': fallback + [cheap],
        }
        assert gates == [pk + '||unlocked'] + full.get(kind, [cheap]), gates
        assert not (d/'fasts').exists(), 'unnecessary fast gate'
        if kind in full:
            assert 'resumed the frozen packet' in run.stdout, run.stdout
        if kind == 'cas-loss':
            assert 'CAS lost to a commit outside the wrapper' in run.stdout, run.stdout
        assert git('reflog', '-1', '--format=%gs', 'refs/heads/main').startswith('commit-partial: pid '), 'reflog does not name the wrapper'
for kind in sys.argv[1:] or ['disjoint','intersect','conflict','refused','newfile','manifest','cheapmiss','cas-loss','requeue']: case(kind)
