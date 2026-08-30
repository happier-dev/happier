import fs from 'node:fs';

function assertReadyMarker(marker) {
  if (!fs.existsSync(marker)) throw new Error('Tauri startup-ready event was not observed');
  try {
    if (JSON.parse(fs.readFileSync(marker, 'utf8')).phase !== 'ready') throw new Error();
  } catch {
    throw new Error('Tauri startup-ready event was not observed');
  }
}

export function observeTauriStartup({ app, marker, durationMs, exitDescription }) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = () => {
      clearTimeout(timer);
      app.off('error', onError);
      app.off('exit', onExit);
    };
    const onError = (error) => {
      finish();
      reject(error);
    };
    const onExit = (code, signal) => {
      finish();
      reject(new Error(`${exitDescription} with code=${code} signal=${signal}`));
    };
    app.once('error', onError);
    app.once('exit', onExit);
    timer = setTimeout(() => {
      finish();
      try { assertReadyMarker(marker); resolve(); } catch (error) { reject(error); }
    }, durationMs);
  });
}
