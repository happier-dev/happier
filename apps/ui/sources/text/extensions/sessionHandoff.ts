import type { SupportedLanguage } from '../_all';

const sessionHandoffTranslationExtension = {
    activeWarning: {
        title: 'This session is still running on this device',
        message: 'Happier will stop this session on the current device before handing it off to the selected device.',
        confirm: 'Hand off and stop here',
    },
    progress: {
        title: 'Handing off session',
        message: 'Preparing the target machine and transferring session state.',
    },
    failure: {
        title: 'Failed to hand off session',
        message: 'The handoff could not be completed. You can try again.',
    },
    recovery: {
        title: 'The session was stopped here before handoff completed',
        messageAfterSourceStop:
            'Happier already stopped this session on the current device, but could not finish starting it on the target device. Restart it here or leave it stopped while you recover the target device.',
        restartOnSource: 'Restart on source',
        keepStopped: 'Keep stopped',
    },
} as const;

const settingsSessionHandoffTranslationExtension = {
    title: 'Session handoff',
    groupTitle: 'Session handoff',
    groupFooter: 'Choose the default options for moving a session between machines.',
    entrySubtitle: 'Open handoff settings',
    workspaceTransfer: {
        groupTitle: 'Workspace transfer',
        groupFooter: 'Decide whether handoff should copy the workspace and how conflicts should be handled by default.',
        title: 'Transfer workspace',
        enabledSubtitle: 'Copy the workspace to the target machine by default.',
        disabledSubtitle: 'Do not change the target machine workspace by default.',
        strategy: {
            title: 'Workspace transfer strategy',
            subtitle: 'Choose a full workspace snapshot or a changes-only sync.',
            transferSnapshotTitle: 'Transfer snapshot',
            transferSnapshotSubtitle: 'Export and transfer a full workspace snapshot.',
            syncChangesTitle: 'Sync changes',
            syncChangesSubtitle: 'Compare source and target workspaces and apply only the needed one-way changes.',
        },
    },
    conflictPolicy: {
        title: 'Workspace conflict policy',
        subtitle: 'Choose what to do when the target path already exists.',
        createSiblingCopyTitle: 'Create sibling copy',
        createSiblingCopySubtitle: 'Keep the existing target path and create a sibling copy for the handoff.',
        replaceExistingTitle: 'Replace existing path',
        replaceExistingSubtitle: 'Replace the existing target path after confirmation.',
    },
    includeIgnoredMode: {
        title: 'Ignored files',
        subtitle: 'Choose how git-ignored files are handled during workspace transfer.',
        excludeTitle: 'Exclude ignored files',
        excludeSubtitle: 'Skip ignored files by default.',
        includeSelectedTitle: 'Include selected ignored files',
        includeSelectedSubtitle: 'Copy only ignored paths that match the configured glob patterns.',
        globsTitle: 'Ignored-file include globs',
        globsPlaceholder: 'dist/**, .env.local',
    },
    directTargetMode: {
        title: 'Direct-session target mode',
        subtitle: 'Choose what happens when a direct session is handed off.',
        groupTitle: 'Direct session handoff',
        groupFooter: 'Applies only when the source session is currently direct.',
        keepDirectTitle: 'Keep direct',
        keepDirectSubtitle: 'Resume the target session as direct if the provider supports it.',
        convertToPersistedTitle: 'Convert to synced',
        convertToPersistedSubtitle: 'Import the transcript and continue as a Happier-synced session.',
    },
} as const;

function createLocalizedSessionHandoffExtensions() {
    return {
        en: { sessionHandoff: sessionHandoffTranslationExtension, settingsSessionHandoff: settingsSessionHandoffTranslationExtension },
        ru: {
            sessionHandoff: {
                activeWarning: {
                    title: 'Этот сеанс все еще запущен на этом устройстве',
                    message: 'Перед передачей на выбранное устройство Happier остановит этот сеанс на текущем устройстве.',
                    confirm: 'Передать и остановить здесь',
                },
                progress: {
                    title: 'Передача сессии',
                    message: 'Подготавливаем целевую машину и переносим состояние сессии.',
                },
                failure: {
                    title: 'Не удалось передать сессию',
                    message: 'Не удалось завершить передачу. Вы можете повторить попытку.',
                },
                recovery: {
                    title: 'Сеанс был остановлен здесь до завершения передачи',
                    messageAfterSourceStop:
                        'Happier уже остановил этот сеанс на текущем устройстве, но не смог завершить запуск на целевом устройстве. Перезапустите его здесь или оставьте остановленным, пока восстанавливаете целевое устройство.',
                    restartOnSource: 'Перезапустить на исходной машине',
                    keepStopped: 'Оставить остановленной',
                },
            },
            settingsSessionHandoff: settingsSessionHandoffTranslationExtension,
        },
        pl: {
            sessionHandoff: {
                activeWarning: {
                    title: 'Ta sesja nadal działa na tym urządzeniu',
                    message: 'Przekazanie zatrzyma tę sesję na tym urządzeniu przed przeniesieniem jej na wybrane urządzenie.',
                    confirm: 'Przekaż i zatrzymaj tutaj',
                },
                progress: {
                    title: 'Przekazywanie sesji',
                    message: 'Przygotowujemy maszynę docelową i przenosimy stan sesji.',
                },
                failure: {
                    title: 'Przekazanie sesji nie powiodło się',
                    message: 'Nie udało się ukończyć przekazania. Możesz spróbować ponownie.',
                },
                recovery: {
                    title: 'Sesja została zatrzymana tutaj przed ukończeniem przekazania',
                    messageAfterSourceStop:
                        'Happier już zatrzymał tę sesję na tym urządzeniu, ale nie mógł dokończyć jej uruchamiania na urządzeniu docelowym. Uruchom ją ponownie tutaj albo pozostaw zatrzymaną, dopóki nie przywrócisz urządzenia docelowego.',
                    restartOnSource: 'Uruchom ponownie na źródle',
                    keepStopped: 'Pozostaw zatrzymaną',
                },
            },
            settingsSessionHandoff: settingsSessionHandoffTranslationExtension,
        },
        es: {
            sessionHandoff: {
                activeWarning: {
                    title: 'Esta sesión sigue ejecutándose aquí',
                    message: 'La transferencia detendrá esta sesión en esta máquina antes de transferirla a la máquina seleccionada.',
                    confirm: 'Transferir y detener aquí',
                },
                progress: {
                    title: 'Transfiriendo sesion',
                    message: 'Preparando la maquina de destino y moviendo el estado de la sesion.',
                },
                failure: {
                    title: 'No se pudo transferir la sesion',
                    message: 'No se pudo completar la transferencia. Puedes volver a intentarlo.',
                },
                recovery: {
                    title: 'La sesión se detuvo aquí antes de completar la transferencia',
                    messageAfterSourceStop:
                        'Happier ya detuvo esta sesión en esta máquina, pero no pudo terminar de iniciarla en la máquina de destino. Reiníciala aquí o mantenla detenida mientras recuperas la máquina de destino.',
                    restartOnSource: 'Reiniciar en el origen',
                    keepStopped: 'Mantener detenida',
                },
            },
            settingsSessionHandoff: settingsSessionHandoffTranslationExtension,
        },
        it: {
            sessionHandoff: {
                activeWarning: {
                    title: 'Questa sessione è ancora in esecuzione qui',
                    message: 'Il trasferimento fermerà questa sessione su questa macchina prima di trasferirla alla macchina selezionata.',
                    confirm: 'Trasferisci e ferma qui',
                },
                progress: {
                    title: 'Trasferimento della sessione',
                    message: 'Preparazione della macchina di destinazione e spostamento dello stato della sessione.',
                },
                failure: {
                    title: 'Trasferimento della sessione non riuscito',
                    message: 'Non e stato possibile completare il trasferimento. Puoi riprovare.',
                },
                recovery: {
                    title: 'La sessione è stata fermata qui prima di completare il trasferimento',
                    messageAfterSourceStop:
                        'Happier ha già fermato questa sessione su questa macchina, ma non è riuscito a completarne l’avvio sulla macchina di destinazione. Riavviala qui oppure lasciala ferma mentre ripristini la macchina di destinazione.',
                    restartOnSource: 'Riavvia sull origine',
                    keepStopped: 'Lasciala arrestata',
                },
            },
            settingsSessionHandoff: settingsSessionHandoffTranslationExtension,
        },
        pt: {
            sessionHandoff: {
                activeWarning: {
                    title: 'Esta sessão ainda está em execução aqui',
                    message: 'A transferência vai parar esta sessão nesta máquina antes de transferi-la para a máquina selecionada.',
                    confirm: 'Transferir e parar aqui',
                },
                progress: {
                    title: 'Transferindo sessao',
                    message: 'Preparando a maquina de destino e movendo o estado da sessao.',
                },
                failure: {
                    title: 'Falha ao transferir a sessao',
                    message: 'Nao foi possivel concluir a transferencia. Voce pode tentar novamente.',
                },
                recovery: {
                    title: 'A sessão foi parada aqui antes de a transferência ser concluída',
                    messageAfterSourceStop:
                        'O Happier já parou esta sessão nesta máquina, mas não conseguiu concluir a inicialização na máquina de destino. Reinicie-a aqui ou mantenha-a parada enquanto recupera a máquina de destino.',
                    restartOnSource: 'Reiniciar na origem',
                    keepStopped: 'Manter parada',
                },
            },
            settingsSessionHandoff: settingsSessionHandoffTranslationExtension,
        },
        ca: {
            sessionHandoff: {
                activeWarning: {
                    title: 'Aquesta sessió encara s’està executant aquí',
                    message: 'La transferència aturarà aquesta sessió en aquesta màquina abans de transferir-la a la màquina seleccionada.',
                    confirm: 'Transferir i aturar aquí',
                },
                progress: {
                    title: 'Transferint la sessio',
                    message: 'S esta preparant la maquina de destinacio i movent l estat de la sessio.',
                },
                failure: {
                    title: 'No s ha pogut transferir la sessio',
                    message: 'No s ha pogut completar la transferencia. Pots tornar-ho a provar.',
                },
                recovery: {
                    title: 'La sessió s’ha aturat aquí abans de completar la transferència',
                    messageAfterSourceStop:
                        'Happier ja ha aturat aquesta sessió en aquesta màquina, però no ha pogut acabar d’iniciar-la a la màquina de destinació. Reinicia-la aquí o mantén-la aturada mentre recuperes la màquina de destinació.',
                    restartOnSource: 'Reinicia a l origen',
                    keepStopped: 'Mantingues-la aturada',
                },
            },
            settingsSessionHandoff: settingsSessionHandoffTranslationExtension,
        },
        'zh-Hans': {
            sessionHandoff: {
                activeWarning: {
                    title: '此会话仍在此设备上运行',
                    message: '开始移交前，Happier 会先在这台设备上停止此会话，然后再将其转移到所选设备。',
                    confirm: '在此停止并移交',
                },
                progress: {
                    title: '正在移交会话',
                    message: '正在准备目标机器并迁移会话状态。',
                },
                failure: {
                    title: '会话移交失败',
                    message: '无法完成移交。你可以重试这次传输。',
                },
                recovery: {
                    title: '此设备上的会话在移交完成前已停止',
                    messageAfterSourceStop:
                        'Happier 已经在这台设备上停止了此会话，但未能在目标设备上完成启动。你可以在这里重新启动，或在恢复目标设备期间保持其停止状态。',
                    restartOnSource: '在源端重启',
                    keepStopped: '保持停止',
                },
            },
            settingsSessionHandoff: settingsSessionHandoffTranslationExtension,
        },
        'zh-Hant': {
            sessionHandoff: {
                activeWarning: {
                    title: '此工作階段仍在這台裝置上執行',
                    message: '開始移交前，Happier 會先在這台裝置上停止此工作階段，再將其轉移到所選裝置。',
                    confirm: '在此停止並移交',
                },
                progress: {
                    title: '正在移交工作階段',
                    message: '正在準備目標機器並移動工作階段狀態。',
                },
                failure: {
                    title: '工作階段移交失敗',
                    message: '無法完成移交。你可以重新嘗試這次傳輸。',
                },
                recovery: {
                    title: '這台裝置上的工作階段在移交完成前已停止',
                    messageAfterSourceStop:
                        'Happier 已經在這台裝置上停止了此工作階段，但未能在目標裝置上完成啟動。你可以在此重新啟動，或在恢復目標裝置期間維持停止狀態。',
                    restartOnSource: '在來源端重新啟動',
                    keepStopped: '保持停止',
                },
            },
            settingsSessionHandoff: settingsSessionHandoffTranslationExtension,
        },
        ja: {
            sessionHandoff: {
                activeWarning: {
                    title: 'このセッションはこのマシンでまだ実行中です',
                    message: 'ハンドオフを開始すると、選択したマシンへ転送する前にこのマシン上のセッションを停止します。',
                    confirm: 'ここで停止してハンドオフ',
                },
                progress: {
                    title: 'セッションを引き継ぎ中',
                    message: '対象のマシンを準備し、セッションの状態を移動しています。',
                },
                failure: {
                    title: 'セッションの引き継ぎに失敗しました',
                    message: '引き継ぎを完了できませんでした。もう一度転送を試せます。',
                },
                recovery: {
                    title: 'ハンドオフ完了前にこのマシンでセッションが停止されました',
                    messageAfterSourceStop:
                        'Happier はこのマシン上のセッションをすでに停止しましたが、転送先マシンでの起動を完了できませんでした。ここで再起動するか、転送先マシンの復旧中は停止したままにしてください。',
                    restartOnSource: '元の環境で再開',
                    keepStopped: '停止したままにする',
                },
            },
            settingsSessionHandoff: settingsSessionHandoffTranslationExtension,
        },
    } as const;
}

export const sessionHandoffTranslationExtensions = createLocalizedSessionHandoffExtensions();

export type SessionHandoffTranslationExtension = (typeof sessionHandoffTranslationExtensions)['en'];
export type SettingsSessionHandoffTranslationExtension = (typeof sessionHandoffTranslationExtensions)['en'];
